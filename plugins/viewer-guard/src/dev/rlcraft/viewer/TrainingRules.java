package dev.rlcraft.viewer;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.bukkit.*;
import org.bukkit.command.*;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.*;
import org.bukkit.event.*;
import org.bukkit.event.entity.*;
import org.bukkit.plugin.java.JavaPlugin;

/** Agent rules plus temporary, shared-world overrides, owned by active run leases. */
final class TrainingRules implements Listener {
    private static final Set<String> SCOPED = Set.of("keepInventory", "noHungerLoss", "creeperEntityDamage", "pvp", "fallDamage", "drowningDamage", "fireDamage");
    private static final Set<String> BOOLEAN_WORLD = Set.of("doDaylightCycle", "doWeatherCycle", "doMobSpawning", "mobGriefing", "doFireTick", "naturalRegeneration", "doMobLoot", "doTileDrops", "doEntityDrops", "doInsomnia", "doPatrolSpawning", "doTraderSpawning");
    private final JavaPlugin plugin;
    private final File backup;
    private final Map<String, Lease> leases = new HashMap<>();
    private final Set<UUID> agents = new HashSet<>();
    private record Lease(String run, World world, int agents, Map<String, Boolean> scoped, Map<String, Object> worldRules, boolean creeperBlocks, long[] lastSeen) {}
    TrainingRules(JavaPlugin plugin) {
        this.plugin = plugin;
        backup = new File(plugin.getDataFolder(), "training-world-rules.yml");
        restore(); // Recover overrides left behind by a crashed Java process.
        Bukkit.getPluginManager().registerEvents(this, plugin);
        Bukkit.getScheduler().runTaskTimer(plugin, () -> {
            for (Lease lease : List.copyOf(leases.values()))
                if (System.currentTimeMillis() - lease.lastSeen[0] > 60000) release(lease.run);
        }, 20L, 20L);
    }
    void register(Player player) { agents.add(player.getUniqueId()); }
    void unregister(Player player) { agents.remove(player.getUniqueId()); }
    private Lease lease(Player player) {
        if (!agents.contains(player.getUniqueId())) return null;
        return leases.values().stream().filter(l -> {
            String prefix = "rl_" + l.run.substring(0, 6) + "_";
            if (!player.getName().startsWith(prefix)) return false;
            try { int index = Integer.parseInt(player.getName().substring(prefix.length())); return index >= 0 && index < l.agents; }
            catch (NumberFormatException error) { return false; }
        }).findFirst().orElse(null);
    }
    private boolean setting(Player player, String key, boolean fallback) {
        Lease lease = lease(player);
        return lease == null ? fallback : lease.scoped.get(key);
    }
    private static boolean bool(ConfigurationSection section, String key) {
        Object value = section.get(key);
        if (!(value instanceof Boolean)) throw new IllegalArgumentException("Expected boolean: " + key);
        return (Boolean)value;
    }
    private static int integer(Object value, int max) {
        if (!(value instanceof Number)) throw new IllegalArgumentException("Expected integer");
        double number = ((Number)value).doubleValue();
        if (!Double.isFinite(number) || number != Math.floor(number) || number < 0 || number > max) throw new IllegalArgumentException("Integer outside allowed range");
        return (int)number;
    }
    boolean command(CommandSender sender, String[] args) {
        if (!(sender instanceof ConsoleCommandSender)) { sender.sendMessage("Training rules are console-only."); return true; }
        if (args.length == 2 && args[0].equals("release") && args[1].matches("[a-f0-9-]{36}")) { release(args[1]); return true; }
        if (args.length != 3 || !args[0].matches("[a-f0-9-]{36}")) return false;
        String request = args[0];
        try {
            UUID.fromString(args[1]);
            if (args[2].length() > 8192) throw new IllegalArgumentException("Rules payload too large");
            YamlConfiguration payload = new YamlConfiguration();
            payload.loadFromString(new String(Base64.getUrlDecoder().decode(args[2]), StandardCharsets.UTF_8));
            ConfigurationSection rules = Objects.requireNonNull(payload.getConfigurationSection("rules"));
            if (!Set.of("keepInventory", "noHungerLoss", "creeperBlockDamage", "creeperEntityDamage", "pvp", "fallDamage", "drowningDamage", "fireDamage", "difficulty", "world").containsAll(rules.getKeys(false))) throw new IllegalArgumentException("Unknown training rule");
            Map<String, Boolean> scoped = new HashMap<>();
            for (String key : SCOPED) scoped.put(key, bool(rules, key));
            boolean creeperBlocks = bool(rules, "creeperBlockDamage");
            Map<String, Object> nativeRules = new TreeMap<>();
            String difficulty = rules.getString("difficulty");
            if (!Set.of("world", "peaceful", "easy", "normal", "hard").contains(difficulty)) throw new IllegalArgumentException("Invalid difficulty");
            if (!difficulty.equals("world")) nativeRules.put("difficulty", difficulty);
            ConfigurationSection worldRules = rules.getConfigurationSection("world");
            if (worldRules == null && rules.get("world") != null && !(rules.get("world") instanceof Map<?, ?> map && map.isEmpty())) throw new IllegalArgumentException("World rules must be an object");
            // Empty JSON objects may deserialize without a configuration section.
            if (worldRules != null) for (String key : worldRules.getKeys(false)) {
                if (BOOLEAN_WORLD.contains(key)) nativeRules.put(key, bool(worldRules, key));
                else if (key.equals("randomTickSpeed")) nativeRules.put(key, integer(worldRules.get(key), 100));
                else if (key.equals("spawnRadius")) nativeRules.put(key, integer(worldRules.get(key), 128));
                else throw new IllegalArgumentException("Unsupported world rule: " + key);
            }
            int count = integer(payload.get("agents"), 128);
            if (count < 1) throw new IllegalArgumentException("No agents configured");
            World world = Bukkit.getWorlds().stream().filter(w -> w.getEnvironment() == World.Environment.NORMAL).findFirst().orElseThrow();
            for (Lease existing : leases.values())
                if (!existing.worldRules.equals(nativeRules) || existing.creeperBlocks != creeperBlocks) throw new IllegalArgumentException("World rules conflict with another experiment");
            if (leases.containsKey(args[1])) throw new IllegalArgumentException("Run rules already applied");
            if (leases.values().stream().anyMatch(l -> l.run.substring(0, 6).equals(args[1].substring(0, 6)))) throw new IllegalArgumentException("Agent username prefix collision");
            if (leases.isEmpty() && !nativeRules.isEmpty()) {
                YamlConfiguration original = new YamlConfiguration();
                original.set("world", world.getUID().toString());
                for (String key : nativeRules.keySet()) original.set("values." + key, key.equals("difficulty") ? world.getDifficulty().name() : world.getGameRuleValue(Objects.requireNonNull(GameRule.getByName(key))));
                original.save(backup); // Save recovery data before changing any setting.
                try { for (Map.Entry<String, Object> entry : nativeRules.entrySet()) apply(world, entry.getKey(), entry.getValue()); }
                catch (Exception error) { restore(); throw error; }
            }
            leases.put(args[1], new Lease(args[1], world, count, scoped, nativeRules, creeperBlocks, new long[] { System.currentTimeMillis() }));
            plugin.getLogger().info("RLCRAFT_RULES_OK " + request);
        } catch (Exception error) {
            plugin.getLogger().warning("RLCRAFT_RULES_ERROR " + request + " " + String.valueOf(error.getMessage()).replace('\n', ' ').replace('\r', ' '));
        }
        return true;
    }
    @SuppressWarnings({"rawtypes", "unchecked"})
    private void apply(World world, String key, Object value) {
        if (key.equals("difficulty")) { world.setDifficulty(Difficulty.valueOf(value.toString().toUpperCase(Locale.ROOT))); return; }
        GameRule rule = Objects.requireNonNull(GameRule.getByName(key));
        if (!world.setGameRule(rule, value)) throw new IllegalArgumentException("World rejected rule " + key);
    }
    private void restore() {
        if (!backup.exists()) return;
        try {
            YamlConfiguration original = YamlConfiguration.loadConfiguration(backup);
            World world = Objects.requireNonNull(Bukkit.getWorld(UUID.fromString(original.getString("world"))), "Rule recovery world is unavailable");
            ConfigurationSection values = Objects.requireNonNull(original.getConfigurationSection("values"));
            for (String key : values.getKeys(false)) apply(world, key, values.get(key));
            world.save(); // Persist restoration before retiring its crash-recovery record.
            if (!backup.delete()) throw new IllegalStateException("Cannot remove completed rules recovery file");
            plugin.getLogger().info("Training world rules restored");
        } catch (Exception error) { throw new IllegalStateException("Cannot restore training world rules; recovery file preserved", error); }
    }
    private void release(String run) {
        if (leases.remove(run) == null) return;
        if (leases.isEmpty()) restore();
        plugin.getLogger().info("Training rules released for run " + run);
    }
    void heartbeat(String encoded) {
        try {
            YamlConfiguration payload = new YamlConfiguration();
            payload.loadFromString(new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.UTF_8));
            for (Map<?, ?> row : payload.getMapList("runs")) {
                Lease lease = leases.get(row.get("id"));
                if (lease != null && Set.of("running", "paused", "pausing").contains(row.get("status"))) lease.lastSeen[0] = System.currentTimeMillis();
            }
        } catch (Exception error) { /* Invalid frames cannot extend a lease. */ }
    }
    void close() { leases.clear(); agents.clear(); restore(); }
    @EventHandler(priority = EventPriority.HIGHEST)
    public void death(PlayerDeathEvent event) {
        Player player = event.getEntity();
        if (!agents.contains(player.getUniqueId())) return;
        boolean keep = setting(player, "keepInventory", true);
        event.setKeepInventory(keep); event.setKeepLevel(keep);
        if (keep) { event.getDrops().clear(); event.setDroppedExp(0); }
        else {
            // Override a world's keepInventory=true for this owned training player.
            event.getDrops().clear();
            for (org.bukkit.inventory.ItemStack item : player.getInventory().getContents())
                if (item != null && !item.getType().isAir()) event.getDrops().add(item.clone());
            event.setDroppedExp(Math.min(100, player.getLevel() * 7));
            event.setNewExp(0); event.setNewLevel(0); event.setNewTotalExp(0);
        }
    }
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void hunger(FoodLevelChangeEvent event) {
        if (event.getEntity() instanceof Player player && setting(player, "noHungerLoss", false) && event.getFoodLevel() < player.getFoodLevel()) event.setCancelled(true);
    }
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void exhaustion(EntityExhaustionEvent event) {
        if (event.getEntity() instanceof Player player && setting(player, "noHungerLoss", false)) event.setCancelled(true);
    }
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void explosion(EntityExplodeEvent event) {
        if (!(event.getEntity() instanceof Creeper)) return;
        if (leases.values().stream().anyMatch(l -> l.world.equals(event.getLocation().getWorld()) && !l.creeperBlocks)) { event.blockList().clear(); event.setYield(0); }
    }
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void damage(EntityDamageEvent event) {
        if (!(event.getEntity() instanceof Player player)) return;
        String key = switch (event.getCause()) {
            case FALL -> "fallDamage";
            case DROWNING -> "drowningDamage";
            case FIRE, FIRE_TICK, LAVA, HOT_FLOOR -> "fireDamage";
            default -> null;
        };
        if (key != null && !setting(player, key, true)) event.setCancelled(true);
        if (event instanceof EntityDamageByEntityEvent attack) {
            Entity damager = attack.getDamager();
            if (damager instanceof Creeper && !setting(player, "creeperEntityDamage", true)) event.setCancelled(true);
            Object source = damager instanceof Projectile projectile ? projectile.getShooter() : damager;
            if (source instanceof Player attacker && (!setting(player, "pvp", true) || !setting(attacker, "pvp", true))) event.setCancelled(true);
        }
    }
}
