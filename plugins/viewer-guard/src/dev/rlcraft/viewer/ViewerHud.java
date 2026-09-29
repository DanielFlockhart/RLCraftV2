package dev.rlcraft.viewer;

import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.Predicate;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.boss.*;
import org.bukkit.scoreboard.*;

/** Personal display only: never touches the main scoreboard, teams or world entities. */
final class ViewerHud implements Listener {
    private final ViewerGuard plugin;
    private final Predicate<Player> viewer;
    private final Map<UUID, Display> displays = new HashMap<>();
    private final Set<UUID> hidden = new HashSet<>();
    private final Map<UUID, String> selections = new HashMap<>();
    private List<Map<?, ?>> runs = List.of();
    private long receivedAt;

    private static final class Display {
        final Scoreboard previous, board;
        final BossBar bar;
        final Team[] lines = new Team[15];
        Display(Player player) {
            previous = player.getScoreboard();
            board = Bukkit.getScoreboardManager().getNewScoreboard();
            Objective objective = board.registerNewObjective("rlcraft_hud", "dummy", ChatColor.AQUA + "RLCraft Training");
            objective.setDisplaySlot(DisplaySlot.SIDEBAR);
            for (int i = 0; i < lines.length; i++) {
                String entry = ChatColor.values()[i].toString();
                lines[i] = board.registerNewTeam("line" + i);
                lines[i].addEntry(entry);
                objective.getScore(entry).setScore(15 - i);
            }
            bar = Bukkit.createBossBar("RLCraft training", BarColor.BLUE, BarStyle.SOLID);
            bar.addPlayer(player);
            player.setScoreboard(board);
        }
        void line(int index, String text) { lines[index].setPrefix(text.substring(0, Math.min(60, text.length()))); }
        void remove(Player player) {
            bar.removeAll();
            if (player != null && player.getScoreboard() == board) player.setScoreboard(previous);
        }
    }

    ViewerHud(ViewerGuard plugin, Predicate<Player> viewer) {
        this.plugin = plugin; this.viewer = viewer;
        Bukkit.getPluginManager().registerEvents(this, plugin);
        Bukkit.getScheduler().runTaskTimer(plugin, this::refresh, 20L, 20L);
    }

    boolean sync(CommandSender sender, String[] args) {
        if (!(sender instanceof ConsoleCommandSender)) { sender.sendMessage("HUD sync is console-only."); return true; }
        if (args.length != 1 || args[0].length() > 32768) return false;
        try {
            YamlConfiguration payload = new YamlConfiguration();
            payload.loadFromString(new String(Base64.getUrlDecoder().decode(args[0]), StandardCharsets.UTF_8));
            List<Map<?, ?>> next = payload.getMapList("runs");
            if (next.size() > 16) throw new IllegalArgumentException("Too many HUD runs");
            for (Map<?, ?> row : next) {
                UUID.fromString(string(row, "id"));
                if (!string(row, "stage").matches("[a-z_]{1,32}")) throw new IllegalArgumentException("Invalid stage");
                for (String key : List.of("agents", "episode", "episodes", "progress", "tick", "ticks", "totalMs", "generationMs", "lastGenerationMs", "targetGenerationMs")) {
                    Object value = row.get(key);
                    if (!(value instanceof Number) || !Double.isFinite(((Number) value).doubleValue()))
                        throw new IllegalArgumentException("Invalid HUD number");
                }
            }
            runs = List.copyOf(next); receivedAt = System.currentTimeMillis();
        } catch (Exception error) { sender.sendMessage("HUD sync rejected: " + error.getMessage()); }
        return true;
    }

    boolean command(CommandSender sender, String[] args) {
        if (!(sender instanceof Player) || !viewer.test((Player) sender)) {
            sender.sendMessage("The training HUD is available to protected viewers only."); return true;
        }
        Player player = (Player) sender;
        UUID id = player.getUniqueId();
        String action = args.length == 0 ? "auto" : args[0].toLowerCase(Locale.ROOT);
        if (args.length > 1) return false;
        if (action.equals("off")) {
            hidden.add(id); Display display = displays.remove(id);
            if (display != null) display.remove(player);
        } else if (action.equals("auto") || action.equals("on")) {
            hidden.remove(id); selections.remove(id);
        } else if (action.equals("next")) {
            if (runs.isEmpty()) { sender.sendMessage("No Minecraft experiments available."); return true; }
            Map<?, ?> current = select(player);
            int index = current == null ? -1 : runs.indexOf(current);
            selections.put(id, string(runs.get((index + 1) % runs.size()), "id")); hidden.remove(id);
        } else {
            List<Map<?, ?>> matching = new ArrayList<>();
            for (Map<?, ?> run : runs) if (string(run, "id").startsWith(action)) matching.add(run);
            if (action.length() < 6 || matching.size() != 1) {
                sender.sendMessage("Use /rlcrafthud auto|next|off|<unique run ID prefix (6+ characters)>."); return true;
            }
            selections.put(id, string(matching.get(0), "id")); hidden.remove(id);
        }
        refresh();
        sender.sendMessage("Training HUD: " + action);
        return true;
    }

    private Map<?, ?> select(Player player) {
        String selected = selections.get(player.getUniqueId());
        if (selected != null) {
            for (Map<?, ?> run : runs) if (string(run, "id").equals(selected)) return run;
            return null; // Never silently substitute another experiment for a pinned one.
        }
        Entity target = player.getSpectatorTarget();
        if (target instanceof Player) {
            String name = ((Player) target).getName();
            for (Map<?, ?> run : runs) if (name.startsWith("rl_" + string(run, "id").substring(0, 6) + "_")) return run;
        }
        for (Map<?, ?> run : runs) if (List.of("running", "pausing", "paused").contains(string(run, "status"))) return run;
        return runs.isEmpty() ? null : runs.get(0);
    }

    private void refresh() {
        boolean stale = receivedAt == 0 || System.currentTimeMillis() - receivedAt > 5000;
        for (Player player : Bukkit.getOnlinePlayers()) {
            if (!viewer.test(player) || hidden.contains(player.getUniqueId())) continue;
            Display display = displays.computeIfAbsent(player.getUniqueId(), id -> new Display(player));
            Map<?, ?> run = select(player);
            for (int i = 0; i < 15; i++) display.line(i, " ");
            display.line(0, ChatColor.GRAY + (stale ? "Control disconnected" : "Live training state"));
            if (run == null) {
                display.line(2, selections.containsKey(player.getUniqueId()) ? "Selected run unavailable" : "No Minecraft experiments");
                display.line(4, "/rlcrafthud auto|next|off");
                display.bar.setTitle(stale ? "RLCraft - waiting for control" : "RLCraft - idle");
                display.bar.setColor(BarColor.WHITE); display.bar.setProgress(0);
                continue;
            }
            String status = string(run, "status");
            String stage = string(run, "stage").replace('_', ' ');
            long generation = (long) number(run, "episode");
            double tickProgress = number(run, "ticks") > 0 ? number(run, "tick") / number(run, "ticks") : 0;
            boolean timed = run.get("generationSeconds") instanceof Number && number(run, "generationSeconds") > 0;
            if (timed && run.get("trainingMs") instanceof Number) tickProgress = number(run, "trainingMs") / (number(run, "generationSeconds") * 1000);
            display.line(1, ChatColor.YELLOW + stage);
            display.line(2, "Experiment: " + string(run, "id").substring(0, 8));
            display.line(3, "Status: " + status + " / " + string(run, "phase"));
            display.line(4, "Generation: " + generation + "/" + (long) number(run, "episodes"));
            display.line(5, "Steps: " + (long) number(run, "tick") + "/" + (long) number(run, "ticks"));
            boolean timing = Boolean.TRUE.equals(run.get("timingAvailable"));
            display.line(6, "Gen elapsed: " + (timing ? duration(number(run, "generationMs")) : "--"));
            display.line(7, (timed ? "Active limit: " : "Gen minimum: ") + duration(number(run, "targetGenerationMs")));
            display.line(8, "Previous gen: " + (number(run, "lastGenerationMs") < 0 ? "--" : duration(number(run, "lastGenerationMs"))));
            display.line(9, "Total runtime: " + (timing ? duration(number(run, "totalMs")) : "--"));
            display.line(10, "Run progress: " + Math.round(number(run, "progress") * 100) + "%");
            display.line(11, "Agents: " + (long) number(run, "agents") + " / " + string(run, "component"));
            display.line(12, "World: " + string(run, "world"));
            if (run.get("speed") instanceof Number && run.get("effectiveSpeed") instanceof Number)
                display.line(13, String.format(Locale.ROOT, "Pace: %.2fx / effective %.2fx", number(run, "speed"), number(run, "effectiveSpeed")));
            display.line(14, "/rlcrafthud next | off");
            display.bar.setTitle(stage + " | Gen " + generation + "/" + (long) number(run, "episodes") + " | " + (stale ? "control disconnected" : status));
            display.bar.setProgress(Math.max(0, Math.min(1, tickProgress)));
            display.bar.setColor(stale || status.equals("failed") ? BarColor.RED : status.equals("paused") || status.equals("pausing") ? BarColor.YELLOW : status.equals("completed") ? BarColor.GREEN : BarColor.BLUE);
        }
    }

    private static String string(Map<?, ?> row, String key) {
        return String.valueOf(row.get(key)).replaceAll("[\\p{Cntrl}§]", "");
    }
    private static double number(Map<?, ?> row, String key) { return ((Number) row.get(key)).doubleValue(); }
    private static String duration(double ms) {
        long seconds = (long) Math.max(0, ms / 1000);
        return String.format(Locale.ROOT, "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60);
    }
    @EventHandler public void quit(PlayerQuitEvent event) {
        Display display = displays.remove(event.getPlayer().getUniqueId());
        if (display != null) display.remove(event.getPlayer());
    }
    void close() {
        for (Map.Entry<UUID, Display> entry : displays.entrySet()) entry.getValue().remove(Bukkit.getPlayer(entry.getKey()));
        displays.clear(); selections.clear(); hidden.clear();
    }
}
