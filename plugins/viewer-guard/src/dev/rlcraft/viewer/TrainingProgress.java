package dev.rlcraft.viewer;

import java.util.HashSet;
import java.util.Set;
import java.util.Locale;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.block.Block;
import org.bukkit.block.CreatureSpawner;
import org.bukkit.entity.Entity;
import org.bukkit.entity.EntityType;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

/** Read-only attribution telemetry. Never alters damage, blocks, AI or player inputs. */
final class TrainingProgress implements Listener {
    private final JavaPlugin plugin;
    private final Set<String> sent = new HashSet<>();
    private final BukkitTask poll;
    TrainingProgress(JavaPlugin plugin) {
        this.plugin = plugin;
        Bukkit.getPluginManager().registerEvents(this, plugin);
        poll = Bukkit.getScheduler().runTaskTimer(plugin, this::observe, 20L, 20L);
    }
    private boolean agent(Player player) {
        return player.getName().matches("rl_[a-f0-9]{6}_[0-9]{1,3}")
            && !player.getScoreboardTags().contains("rlcraft.viewer");
    }
    private void emit(Player player, String milestone) {
        if (!agent(player)) return;
        String key = player.getUniqueId() + ":" + player.getGameMode() + ":" + milestone;
        if (!sent.add(key)) return;
        // A fixed private logger prefix is parsed; chat containing these words
        // cannot imitate a plugin log line. Parent verifies current run ownership.
        plugin.getLogger().info("RLCRAFT_PROGRESS " + player.getName() + " " + milestone + " " + player.getGameMode().name().toLowerCase(Locale.ROOT));
    }
    private void observe() {
        for (Player player : Bukkit.getOnlinePlayers()) {
            if (!agent(player)) continue;
            Block target = player.getTargetBlockExact(6);
            if (target != null && target.getType() == Material.SPAWNER
                && target.getState() instanceof CreatureSpawner
                && ((CreatureSpawner) target.getState()).getSpawnedType() == EntityType.BLAZE) {
                emit(player, "blaze-seen");
            }
            if (player.getWorld().getEnvironment() != org.bukkit.World.Environment.THE_END) continue;
            String crystalKey = player.getUniqueId() + ":" + player.getGameMode() + ":crystal";
            if (sent.contains(crystalKey)) continue;
            for (Entity entity : player.getNearbyEntities(32, 32, 32)) {
                if (entity.getType() == EntityType.ENDER_CRYSTAL
                    && player.getEyeLocation().getDirection().dot(entity.getLocation().toVector().subtract(player.getEyeLocation().toVector())) > 0
                    && player.hasLineOfSight(entity)) { emit(player, "crystal"); break; }
            }
        }
    }
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void damage(EntityDamageByEntityEvent event) {
        Entity source = event.getDamager();
        Player player = source instanceof Player ? (Player) source
            : source instanceof Projectile && ((Projectile) source).getShooter() instanceof Player
                ? (Player) ((Projectile) source).getShooter() : null;
        if (player == null || !agent(player) || event.getFinalDamage() <= 0) return;
        if (event.getEntity().getType() == EntityType.ENDER_DRAGON) {
            emit(player, "fight-dragon");
        } else if (event.getEntity().getType() == EntityType.ENDER_CRYSTAL) {
            Entity crystal = event.getEntity();
            // Verify removal after the accepted damage event, not on an attempted/cancelled swing.
            Bukkit.getScheduler().runTask(plugin, () -> {
                if (!crystal.isValid() && player.isOnline()) emit(player, "destroy-crystals");
            });
        }
    }
    @EventHandler public void quit(PlayerQuitEvent event) {
        UUID id = event.getPlayer().getUniqueId();
        sent.removeIf(key -> key.startsWith(id.toString() + ":"));
    }
    void close() { poll.cancel(); sent.clear(); }
}
