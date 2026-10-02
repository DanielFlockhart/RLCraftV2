package dev.rlcraft.viewer;

import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.Map;
import java.util.HashMap;
import java.util.UUID;
import java.util.Base64;
import java.nio.charset.StandardCharsets;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.Location;
import org.bukkit.GameMode;
import org.bukkit.GameRule;
import org.bukkit.World;
import org.bukkit.HeightMap;
import org.bukkit.block.Block;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.inventory.ItemStack;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.entity.EntityTargetLivingEntityEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.player.PlayerChangedWorldEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerGameModeChangeEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.world.WorldLoadEvent;
import org.bukkit.plugin.java.JavaPlugin;

/** Protects named human viewers without changing agent gamemodes or rewards. */
public final class ViewerGuard extends JavaPlugin implements Listener {
    private final Set<String> viewers = new HashSet<>();
    private TrainingArenas arenas;
    private ViewerHud hud;
    private TrainingRules rules;
    private TrainingProgress progress;
    private final Map<UUID, Location> agentSpawns = new HashMap<>();

    @Override
    public void onEnable() {
        saveDefaultConfig();
        for (String name : getConfig().getStringList("viewers")) {
            if (!name.matches("[A-Za-z0-9_]{1,16}")) {
                throw new IllegalArgumentException("Invalid viewer username: " + name);
            }
            viewers.add(name.toLowerCase(Locale.ROOT));
        }
        Bukkit.getPluginManager().registerEvents(this, this);
        for (World world : Bukkit.getWorlds()) protectWorld(world);
        enforceOnlineViewers();
        rules = new TrainingRules(this);
        getLogger().info("Training rules protocol 1 ready");
        // Restore operator status after deop, and repair state changed by other plugins.
        Bukkit.getScheduler().runTaskTimer(this, this::enforceOnlineViewers, 20L, 20L);
        getLogger().info("Viewer protection enabled for " + String.join(", ", viewers));
        getLogger().info("Training setup protocol 2 ready");
        arenas = new TrainingArenas(this, player -> isViewer(player));
        getLogger().info("Training arena protocol 1 ready");
        hud = new ViewerHud(this, player -> isViewer(player));
        getLogger().info("Viewer HUD protocol 1 ready");
        progress = new TrainingProgress(this);
        getLogger().info("Training progress protocol 1 ready");
    }
    @Override public void onDisable() { if (arenas != null) arenas.close(); if (hud != null) hud.close(); if (rules != null) rules.close(); if (progress != null) progress.close(); }

    private boolean isViewer(Entity entity) {
        return entity instanceof Player
            && viewers.contains(((Player) entity).getName().toLowerCase(Locale.ROOT));
    }

    private void protectWorld(World world) {
        // Spectators receive existing terrain without generating/activating new terrain.
        // This spectator-only rule leaves normal training players unchanged.
        world.setGameRule(GameRule.SPECTATORS_GENERATE_CHUNKS, false);
    }

    private void protect(Player viewer) {
        if (!viewer.isOp()) viewer.setOp(true);
        if (viewer.getGameMode() != GameMode.SPECTATOR) viewer.setGameMode(GameMode.SPECTATOR);
        viewer.setCollidable(false);
        viewer.setCanPickupItems(false);
        viewer.setInvulnerable(true);
        viewer.setSleepingIgnored(true);
        viewer.setAffectsSpawning(false);
        viewer.addScoreboardTag("rlcraft.viewer");
        for (Player other : Bukkit.getOnlinePlayers()) {
            if (!isViewer(other) && other.canSee(viewer)) other.hidePlayer(this, viewer);
        }
    }

    private void enforceOnlineViewers() {
        for (Player player : Bukkit.getOnlinePlayers()) {
            if (isViewer(player)) protect(player);
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        if (isViewer(player)) {
            protect(player);
            player.sendMessage("You are an admin spectator. Fly to watch agents, or use /spectate <agent>.");
            getLogger().info(player.getName() + " joined as a protected admin spectator");
        } else {
            for (Player viewer : Bukkit.getOnlinePlayers()) {
                if (isViewer(viewer)) player.hidePlayer(this, viewer);
            }
        }
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onGameMode(PlayerGameModeChangeEvent event) {
        if (isViewer(event.getPlayer()) && event.getNewGameMode() != GameMode.SPECTATOR) {
            event.setCancelled(true);
            event.getPlayer().sendMessage("Viewer mode stays spectator to protect training.");
        }
    }

    @EventHandler
    public void onRespawn(PlayerRespawnEvent event) {
        if (isViewer(event.getPlayer())) {
            Bukkit.getScheduler().runTask(this, () -> protect(event.getPlayer()));
        }
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) { agentSpawns.remove(event.getPlayer().getUniqueId()); if (rules != null) rules.unregister(event.getPlayer()); }


    @EventHandler
    public void onWorldChange(PlayerChangedWorldEvent event) {
        if (isViewer(event.getPlayer())) protect(event.getPlayer());
    }

    @EventHandler
    public void onWorldLoad(WorldLoadEvent event) { protectWorld(event.getWorld()); }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onTarget(EntityTargetLivingEntityEvent event) {
        if (isViewer(event.getTarget())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onAttack(EntityDamageByEntityEvent event) {
        Entity damager = event.getDamager();
        boolean viewerProjectile = damager instanceof Projectile
            && ((Projectile) damager).getShooter() instanceof Player
            && isViewer((Player) ((Projectile) damager).getShooter());
        if (isViewer(damager) || viewerProjectile || isViewer(event.getEntity())) event.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBreak(BlockBreakEvent event) { if (isViewer(event.getPlayer())) event.setCancelled(true); }
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPlace(BlockPlaceEvent event) { if (isViewer(event.getPlayer())) event.setCancelled(true); }
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onInteract(PlayerInteractEvent event) { if (isViewer(event.getPlayer())) event.setCancelled(true); }
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onPickup(EntityPickupItemEvent event) { if (isViewer(event.getEntity())) event.setCancelled(true); }
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onDrop(PlayerDropItemEvent event) { if (isViewer(event.getPlayer())) event.setCancelled(true); }
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onInventoryClick(InventoryClickEvent event) { if (isViewer(event.getWhoClicked())) event.setCancelled(true); }
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onInventoryDrag(InventoryDragEvent event) { if (isViewer(event.getWhoClicked())) event.setCancelled(true); }

    /** Read-only diagnostics for integration checks and local server administration. */
    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (command.getName().equalsIgnoreCase("rlcrafthudsync")) {
            if (sender instanceof ConsoleCommandSender && args.length == 1 && args[0].length() <= 32768) rules.heartbeat(args[0]);
            return hud.sync(sender, args);
        }
        if (command.getName().equalsIgnoreCase("rlcraftrules")) return rules.command(sender, args);
        if (command.getName().equalsIgnoreCase("rlcrafthud")) return hud.command(sender, args);
        if (command.getName().equalsIgnoreCase("rlcraftsetup")) return setupAgent(sender, args);
        if (command.getName().equalsIgnoreCase("rlcraftarena")) return arenas.command(sender, args);
        if (command.getName().equalsIgnoreCase("rlcraftarenastatus")) return arenas.status(sender, args);
        if (command.getName().equalsIgnoreCase("rlcraftarenaspawn")) return arenas.spawn(sender, args);
        if (command.getName().equalsIgnoreCase("rlcraftsurface")) return resolveSurface(sender, args);
        if (args.length != 1) return false;
        Player player = Bukkit.getPlayerExact(args[0]);
        if (player == null) { sender.sendMessage("Player is not online: " + args[0]); return true; }
        sender.sendMessage("ViewerGuard " + player.getName()
            + " viewer=" + isViewer(player) + " op=" + player.isOp()
            + " mode=" + player.getGameMode() + " collision=" + player.isCollidable()
            + " pickup=" + player.getCanPickupItems() + " affectsSpawning=" + player.getAffectsSpawning()
            + " sleepingIgnored=" + player.isSleepingIgnored()
            + " spectatorChunks=" + player.getWorld().getGameRuleValue(GameRule.SPECTATORS_GENERATE_CHUNKS));
        return true;
    }

    private boolean resolveSurface(CommandSender sender, String[] args) {
        if (!(sender instanceof ConsoleCommandSender)) { sender.sendMessage("Terrain lookup is console-only."); return true; }
        if (args.length != 4 || !args[0].matches("[a-f0-9-]{36}")) return false;
        String requestId = args[0];
        try {
            if (!args[1].matches("rl_[a-f0-9]{6}_[0-9]+")) throw new IllegalArgumentException("Not a training agent");
            Player agent = Bukkit.getPlayerExact(args[1]);
            if (agent == null || isViewer(agent)) throw new IllegalArgumentException("Training agent unavailable");
            int x = Integer.parseInt(args[2]), z = Integer.parseInt(args[3]);
            if (Math.abs((long) x) >= 29999984 || Math.abs((long) z) >= 29999984)
                throw new IllegalArgumentException("Target outside world bounds");
            World world = agent.getWorld();
            world.getChunkAtAsync(x >> 4, z >> 4, true).whenComplete((chunk, error) ->
                Bukkit.getScheduler().runTask(this, () -> {
                    try {
                        if (error != null || chunk == null || !agent.isOnline() || agent.getWorld() != world)
                            throw new IllegalStateException("Target chunk unavailable");
                        Location ground = standableTarget(world, x, z);
                        if (ground == null) throw new IllegalStateException("No standable surface near target");
                        getLogger().info(String.format(Locale.ROOT, "RLCRAFT_SURFACE_OK %s %.1f %.1f %.1f",
                            requestId, ground.getX(), ground.getY(), ground.getZ()));
                    } catch (Exception failure) { surfaceError(requestId, failure); }
                })
            );
        } catch (Exception error) { surfaceError(requestId, error); }
        return true;
    }

    private Location standableTarget(World world, int desiredX, int desiredZ) {
        for (int radius = 0; radius <= 8; radius++) {
            for (int dx = -radius; dx <= radius; dx++) for (int dz = -radius; dz <= radius; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) != radius) continue;
                int x = desiredX + dx, z = desiredZ + dz;
                int top = world.getHighestBlockYAt(x, z, HeightMap.MOTION_BLOCKING_NO_LEAVES);
                for (int y = Math.min(top + 1, world.getMaxHeight() - 2); y >= Math.max(world.getMinHeight() + 1, top - 20); y--) {
                    Block floor = world.getBlockAt(x, y - 1, z);
                    Block feet = world.getBlockAt(x, y, z);
                    Block head = world.getBlockAt(x, y + 1, z);
                    if (floor.getType().isSolid() && feet.isPassable() && head.isPassable() &&
                        !feet.isLiquid() && !head.isLiquid() && !floor.isLiquid())
                        return new Location(world, x + 0.5, y, z + 0.5);
                }
            }
        }
        return null;
    }

    private void surfaceError(String requestId, Exception error) {
        getLogger().warning("RLCRAFT_SURFACE_ERROR " + requestId + " " +
            String.valueOf(error.getMessage()).replace('\n', ' ').replace('\r', ' '));
    }

    private boolean setupAgent(CommandSender sender, String[] args) {
        if (!(sender instanceof ConsoleCommandSender)) { sender.sendMessage("Training setup is console-only."); return true; }
        if (args.length != 3 || !args[0].matches("[a-f0-9-]{36}")) return false;
        String requestId = args[0];
        try {
            if (!args[1].matches("rl_[a-f0-9]{6}_[0-9]+")) throw new IllegalArgumentException("Not a training agent");
            Player player = Bukkit.getPlayerExact(args[1]);
            if (player == null || isViewer(player)) throw new IllegalArgumentException("Training agent unavailable or protected viewer");
            if (args[2].length() > 16384) throw new IllegalArgumentException("Setup too large");
            YamlConfiguration setup = new YamlConfiguration();
            setup.loadFromString(new String(Base64.getUrlDecoder().decode(args[2]), StandardCharsets.UTF_8));
            ItemStack[] slots = new ItemStack[41];
            boolean[] assigned = new boolean[41];
            for (Map<?, ?> row : setup.getMapList("items")) {
                int slot = ((Number) row.get("slot")).intValue();
                int count = ((Number) row.get("count")).intValue();
                Material material = Material.matchMaterial((String) row.get("item"));
                if (slot < 0 || slot > 40 || assigned[slot] || material == null || !material.isItem() || material.isAir()
                    || count < 1 || count > material.getMaxStackSize() || (slot >= 36 && slot <= 39 && count != 1))
                    throw new IllegalArgumentException("Invalid inventory item/slot/stack");
                slots[slot] = new ItemStack(material, count);
                assigned[slot] = true;
            }
            double health = setup.getDouble("health");
            int food = setup.getInt("food"), level = setup.getInt("experienceLevel"), held = setup.getInt("heldSlot");
            if (!Double.isFinite(health) || health < 1 || health > 20 || food < 0 || food > 20 || level < 0 || level > 10000 || held < 0 || held > 8)
                throw new IllegalArgumentException("Invalid agent vitals");
            String mode = setup.getString("gamemode", "world");
            GameMode gameMode = mode.equals("world") ? Bukkit.getDefaultGameMode() : GameMode.valueOf(mode.toUpperCase(Locale.ROOT));
            if (gameMode == GameMode.SPECTATOR) throw new IllegalArgumentException("Training setup cannot grant spectator mode");
            Location location = agentSpawns.getOrDefault(player.getUniqueId(), player.getLocation()).clone();
            if (setup.isConfigurationSection("spawn")) {
                double x = setup.getDouble("spawn.x"), y = setup.getDouble("spawn.y"), z = setup.getDouble("spawn.z");
                if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z) || Math.abs(x) > 29999984 || Math.abs(z) > 29999984
                    || y < player.getWorld().getMinHeight() || y >= player.getWorld().getMaxHeight())
                    throw new IllegalArgumentException("Spawn outside world bounds");
                location = new Location(player.getWorld(), x, y, z);
            }
            // Validate the whole request before clearing anything. Only this named agent changes.
            if (location != null && !player.teleport(location)) throw new IllegalArgumentException("Agent teleport rejected");
            agentSpawns.putIfAbsent(player.getUniqueId(), location.clone());
            player.setGameMode(gameMode);
            if (setup.getBoolean("clearInventory")) player.getInventory().clear();
            for (int slot = 0; slot <= 40; slot++) if (assigned[slot]) player.getInventory().setItem(slot, slots[slot]);
            player.getInventory().setHeldItemSlot(held);
            if (setup.getBoolean("resetVitals")) {
                player.setHealth(health); player.setFoodLevel(food); player.setSaturation(Math.min(food, 5));
                player.setExhaustion(0); player.setFireTicks(0); player.setFallDistance(0);
                for (org.bukkit.potion.PotionEffect effect : player.getActivePotionEffects()) player.removePotionEffect(effect.getType());
                player.setVelocity(new org.bukkit.util.Vector(0, 0, 0));
                player.setExp(0); player.setLevel(level);
                player.sendHealthUpdate();
            }
            player.addScoreboardTag("rlcraft.agent");
            rules.register(player);
            player.updateInventory();
            getLogger().info("RLCRAFT_SETUP_OK " + requestId);
        } catch (Exception error) {
            String message = String.valueOf(error.getMessage()).replace('\n', ' ').replace('\r', ' ');
            getLogger().warning("RLCRAFT_SETUP_ERROR " + requestId + " " + message);
        }
        return true;
    }
}
