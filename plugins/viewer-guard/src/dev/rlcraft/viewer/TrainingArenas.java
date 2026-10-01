package dev.rlcraft.viewer;

import java.util.*;
import java.util.function.Predicate;
import java.nio.charset.StandardCharsets;
import org.bukkit.*;
import org.bukkit.block.Container;
import org.bukkit.command.*;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.*;
import org.bukkit.event.*;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerTeleportEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

/** Console-only, bounded arena preparation. All block/entity mutations stay on the main thread. */
final class TrainingArenas implements Listener {
    private final JavaPlugin plugin;
    private final Predicate<Player> viewer;
    private final Map<String, Job> jobs = new HashMap<>();
    private final Map<String, Plan> ready = new HashMap<>();
    private final Map<String, Integer> tickets = new HashMap<>();
    private static final Set<String> MOB_TYPES = Set.of("cow", "pig", "sheep", "chicken", "zombie", "skeleton", "spider");
    TrainingArenas(JavaPlugin plugin, Predicate<Player> viewer) {
        this.plugin = plugin; this.viewer = viewer;
        Bukkit.getPluginManager().registerEvents(this, plugin);
    }
    private record Point(int x, int y, int z) {}
    private record Region(Point from, Point to, Material block) {}
    private record Stock(Point position, Material block, Map<Integer, ItemStack> items) {}
    private record Mob(Point position, EntityType type, int count) {}
    private static int integer(Object value, int min, int max) {
        if (!(value instanceof Number)) throw new IllegalArgumentException("Expected integer");
        double number = ((Number)value).doubleValue();
        if (!Double.isFinite(number) || number != Math.floor(number) || number < min || number > max) throw new IllegalArgumentException("Integer out of bounds");
        return (int)number;
    }
    private static Point point(Map<?, ?> row) { return new Point(integer(row.get("x"), 0, 31), integer(row.get("y"), 0, 15), integer(row.get("z"), 0, 31)); }
    private static Material material(Object value) {
        if (!(value instanceof String) || !((String)value).matches("minecraft:[a-z0-9_]+")) throw new IllegalArgumentException("Invalid block identifier");
        Material result = Material.matchMaterial((String)value);
        if (result == null || !result.isBlock()) throw new IllegalArgumentException("Unknown block");
        return result;
    }
    private static boolean within(Point p, Point min, Point max) { return p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y && p.z >= min.z && p.z <= max.z; }
    private final class Plan {
        final String run; final World world; final int agents, width, height, depth; final Material floor, walls, roof;
        final Point spawn; final List<Point> cells = new ArrayList<>();
        final List<Region> regions = new ArrayList<>(); final List<Stock> stocks = new ArrayList<>(); final List<Mob> mobs = new ArrayList<>();
        Plan(String run, YamlConfiguration payload) {
            this.run = run;
            this.world = Bukkit.getWorlds().stream().filter(w -> w.getEnvironment() == World.Environment.NORMAL).findFirst().orElseThrow();
            agents = integer(payload.get("agents"), 1, 128);
            ConfigurationSection spec = Objects.requireNonNull(payload.getConfigurationSection("arena"));
            ConfigurationSection blueprint = Objects.requireNonNull(spec.getConfigurationSection("blueprint"));
            width = integer(blueprint.get("width"), 3, 32); depth = integer(blueprint.get("depth"), 3, 32); height = integer(blueprint.get("height"), 3, 16);
            floor = material(blueprint.get("floor")); walls = material(blueprint.get("walls")); roof = material(blueprint.get("roof"));
            if (!floor.isSolid()) throw new IllegalArgumentException("Floor must be solid");
            ConfigurationSection s = Objects.requireNonNull(blueprint.getConfigurationSection("spawn"));
            spawn = new Point(integer(s.get("x"), 0, width-1), integer(s.get("y"), 0, height-2), integer(s.get("z"), 0, depth-1));
            if (blueprint.getMapList("regions").size() > 32 || blueprint.getMapList("containers").size() > 8 || blueprint.getMapList("entities").size() > 16) throw new IllegalArgumentException("Too many arena contents");
            for (Map<?, ?> row : blueprint.getMapList("regions")) {
                Point from = point((Map<?, ?>)row.get("from")), to = point((Map<?, ?>)row.get("to"));
                check(from); check(to);
                if (from.x > to.x || from.y > to.y || from.z > to.z) throw new IllegalArgumentException("Inverted region");
                regions.add(new Region(from, to, material(row.get("block"))));
            }
            Set<Point> occupied = new HashSet<>();
            for (Map<?, ?> row : blueprint.getMapList("containers")) {
                Point p = point((Map<?, ?>)row.get("position")); check(p);
                Material block = material(row.get("block"));
                if ((block != Material.CHEST && block != Material.BARREL) || !occupied.add(p)) throw new IllegalArgumentException("Invalid/duplicate container");
                Map<Integer, ItemStack> items = new HashMap<>();
                List<?> rows = (List<?>)row.get("items");
                if (rows.size() > 27) throw new IllegalArgumentException("Too many container items");
                for (Object value : rows) {
                    Map<?, ?> item = (Map<?, ?>)value;
                    int slot = integer(item.get("slot"), 0, 26), count = integer(item.get("count"), 1, 64);
                    Material type = Material.matchMaterial((String)item.get("item"));
                    if (type == null || !type.isItem() || type.isAir() || count > type.getMaxStackSize() || items.containsKey(slot)) throw new IllegalArgumentException("Invalid container stock");
                    items.put(slot, new ItemStack(type, count));
                }
                stocks.add(new Stock(p, block, items));
            }
            if (!at(spawn).isAir() || !at(new Point(spawn.x, spawn.y+1, spawn.z)).isAir() || (spawn.y > 0 && !at(new Point(spawn.x, spawn.y-1, spawn.z)).isSolid())) throw new IllegalArgumentException("Spawn must have clear feet/head and support");
            int mobCount = 0;
            for (Map<?, ?> row : blueprint.getMapList("entities")) {
                Point p = point((Map<?, ?>)row.get("position")); check(p);
                String type = (String)row.get("type");
                int count = integer(row.get("count"), 1, 8); mobCount += count;
                if (!MOB_TYPES.contains(type) || p.y+1 >= height || !at(p).isAir() || !at(new Point(p.x, p.y+1, p.z)).isAir()) throw new IllegalArgumentException("Invalid mob spawn");
                mobs.add(new Mob(p, EntityType.valueOf(type.toUpperCase(Locale.ROOT)), count));
            }
            String layout = spec.getString("layout");
            if (!Set.of("shared", "individual").contains(layout)) throw new IllegalArgumentException("Invalid layout");
            int count = layout.equals("shared") ? 1 : agents;
            if ((long)(width+2)*(depth+2)*(height+2)*count > 524288 || mobCount > 16 || mobCount*count > 128) throw new IllegalArgumentException("Arena block/mob budget exceeded");
            int columns = integer(spec.get("columns"), 1, 16), gap = integer(spec.get("gap"), 2, 32);
            ConfigurationSection origin = Objects.requireNonNull(spec.getConfigurationSection("origin"));
            int x = integer(origin.get("x"), -29999984, 29999984), y = integer(origin.get("y"), world.getMinHeight(), world.getMaxHeight()-1), z = integer(origin.get("z"), -29999984, 29999984);
            for (int i=0; i<count; i++) {
                Point cell = new Point(x + (i%columns)*(width+2+gap), y, z + (i/columns)*(depth+2+gap));
                if (Math.abs((long)cell.x+width+1) > 29999984 || Math.abs((long)cell.z+depth+1) > 29999984 || cell.y+height+1 >= world.getMaxHeight()) throw new IllegalArgumentException("Layout outside world bounds");
                cells.add(cell);
            }
        }
        void check(Point p) { if (p.x >= width || p.y >= height || p.z >= depth) throw new IllegalArgumentException("Contents outside cell"); }
        Material at(Point p) {
            Material value = Material.AIR;
            for (Region r : regions) if (within(p, r.from, r.to)) value = r.block;
            for (Stock stock : stocks) if (stock.position.equals(p)) value = stock.block;
            return value;
        }
        boolean contains(Location location) {
            if (location.getWorld() != world) return false;
            Point p = new Point(location.getBlockX(), location.getBlockY(), location.getBlockZ());
            for (Point c : cells) if (within(p, c, new Point(c.x+width+1, c.y+height+1, c.z+depth+1))) return true;
            return false;
        }
        boolean owned(Player player) {
            String prefix = "rl_"+run.substring(0,6)+"_";
            if (!player.getName().startsWith(prefix)) return false;
            try { int index = Integer.parseInt(player.getName().substring(prefix.length())); return index >= 0 && index < agents && player.getName().equals(prefix+index); } catch (Exception ignored) { return false; }
        }
        Location position(Point cell, Point local) { return new Location(world, cell.x+1+local.x+0.5, cell.y+1+local.y, cell.z+1+local.z+0.5); }
        Location spawn(int agent) { return position(cells.get(cells.size()==1 ? 0 : agent), spawn); }
        void checkPlayers() { for (Player player : world.getPlayers()) if (contains(player.getLocation()) && !viewer.test(player) && !owned(player)) throw new IllegalArgumentException("Another player occupies the arena bounds"); }
    }
    private void result(String request, String error) {
        if (error == null) plugin.getLogger().info("RLCRAFT_ARENA_OK " + request);
        else plugin.getLogger().warning("RLCRAFT_ARENA_ERROR " + request + " " + error.replace('\n',' ').replace('\r',' '));
    }
    boolean command(CommandSender sender, String[] args) {
        if (!(sender instanceof ConsoleCommandSender)) { sender.sendMessage("Training arenas are console-only."); return true; }
        if (args.length == 2 && args[0].equals("cancel") && args[1].matches("[a-f0-9-]{36}")) { cancel(args[1]); return true; }
        if (args.length != 3 || !args[0].matches("[a-f0-9-]{36}") || !args[1].matches("[a-f0-9-]{36}")) return false;
        try {
            if (args[2].length() > 49152 || jobs.containsKey(args[1])) throw new IllegalArgumentException("Arena request too large or already running");
            YamlConfiguration payload = new YamlConfiguration();
            payload.loadFromString(new String(Base64.getUrlDecoder().decode(args[2]), StandardCharsets.UTF_8));
            Plan plan = new Plan(args[1], payload); plan.checkPlayers();
            ready.remove(args[1]);
            Job job = new Job(args[0], plan); jobs.put(args[1], job); job.start();
        } catch (Exception error) { result(args[0], String.valueOf(error.getMessage())); }
        return true;
    }
    boolean spawn(CommandSender sender, String[] args) {
        if (!(sender instanceof ConsoleCommandSender)) { sender.sendMessage("Arena spawning is console-only."); return true; }
        if (args.length != 4 || !args[0].matches("[a-f0-9-]{36}") || !args[1].matches("[a-f0-9-]{36}")) return false;
        try {
            Plan plan = ready.get(args[1]);
            int index = integer(Integer.valueOf(args[3]), 0, 127);
            Player player = Bukkit.getPlayerExact(args[2]);
            if (plan == null || index >= plan.agents || player == null || viewer.test(player) || !player.getName().equals("rl_"+plan.run.substring(0,6)+"_"+index)) throw new IllegalArgumentException("Unowned agent or arena not ready");
            Location spawn = plan.spawn(index);
            if (!plan.world.getBlockAt(spawn).isPassable() || !plan.world.getBlockAt(spawn.clone().add(0,1,0)).isPassable()) throw new IllegalArgumentException("Arena spawn is now obstructed");
            player.setFallDistance(0);
            if (!player.teleport(spawn)) throw new IllegalArgumentException("Arena teleport rejected");
            result(args[0], null);
        } catch (Exception error) { result(args[0], String.valueOf(error.getMessage())); }
        return true;
    }
    void cancel(String run) { Job job = jobs.get(run); if (job != null) job.finish("Arena operation cancelled"); ready.remove(run); }
    void close() { for (String run : new ArrayList<>(jobs.keySet())) cancel(run); ready.clear(); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void freeze(PlayerMoveEvent event) {
        if (event instanceof PlayerTeleportEvent) return;
        for (Job job : jobs.values()) if (job.protectedPlayers.containsKey(event.getPlayer().getUniqueId())) {
            Location from = event.getFrom().clone();
            if (event.getTo() != null) { from.setYaw(event.getTo().getYaw()); from.setPitch(event.getTo().getPitch()); }
            event.setTo(from); return;
        }
    }
    private final class Job {
        final String request; final Plan plan; final List<Point> chunks = new ArrayList<>(); final List<Point> held = new ArrayList<>();
        final Map<UUID, Boolean> protectedPlayers = new HashMap<>();
        BukkitTask task, deadline; int cursor = 0;
        Job(String request, Plan plan) {
            this.request=request; this.plan=plan;
            Set<String> seen = new HashSet<>();
            for (Point c : plan.cells) for (int x=c.x>>4; x<=(c.x+plan.width+1)>>4; x++) for (int z=c.z>>4; z<=(c.z+plan.depth+1)>>4; z++) if (seen.add(x+":"+z)) chunks.add(new Point(x,0,z));
        }
        boolean active() { return jobs.get(plan.run)==this; }
        String ticket(Point chunk) { return plan.world.getUID()+":"+chunk.x+":"+chunk.z; }
        void start() { deadline=Bukkit.getScheduler().runTaskLater(plugin, () -> finish("Arena preparation exceeded 300 seconds"), 6000L); preload(0); }
        void preload(int index) {
            if (!active()) return;
            if (index == chunks.size()) {
                try {
                    plan.checkPlayers();
                    for (Player player : plan.world.getPlayers()) if (plan.owned(player) && !viewer.test(player)) {
                        protectedPlayers.put(player.getUniqueId(), player.isInvulnerable()); player.setInvulnerable(true);
                        int agent = Integer.parseInt(player.getName().substring(player.getName().lastIndexOf('_')+1));
                        Location location = plan.spawn(agent);
                        plan.world.getBlockAt(location).setType(Material.AIR, false);
                        plan.world.getBlockAt(location.clone().add(0,1,0)).setType(Material.AIR, false);
                        plan.world.getBlockAt(location.clone().add(0,-1,0)).setType(plan.spawn.y==0 ? plan.floor : plan.at(new Point(plan.spawn.x,plan.spawn.y-1,plan.spawn.z)), false);
                        if (!player.teleport(location)) throw new IllegalArgumentException("Agent holding teleport rejected");
                    }
                    for (Entity entity : plan.world.getEntities()) if (!(entity instanceof Player) && plan.contains(entity.getLocation())) entity.remove();
                    task=Bukkit.getScheduler().runTaskTimer(plugin, this::step, 1L, 1L);
                } catch (Exception error) { finish(String.valueOf(error.getMessage())); }
                return;
            }
            Point chunk = chunks.get(index);
            plan.world.getChunkAtAsync(chunk.x, chunk.z, true).whenComplete((loaded,error) -> {
                if (!plugin.isEnabled()) return;
                Bukkit.getScheduler().runTask(plugin, () -> {
                    if (!active()) return;
                    if (error != null) { finish("Arena chunk load failed: "+error.getMessage()); return; }
                    String key=ticket(chunk);
                    if (!tickets.containsKey(key)) plan.world.addPluginChunkTicket(chunk.x, chunk.z, plugin);
                    tickets.put(key,tickets.getOrDefault(key,0)+1); held.add(chunk); preload(index+1);
                });
            });
        }
        void step() {
            if (!active()) return;
            try {
                plan.checkPlayers();
                int volume=(plan.width+2)*(plan.depth+2)*(plan.height+2), total=volume*plan.cells.size();
                for (int n=0; n<512 && cursor<total; n++,cursor++) {
                    Point c=plan.cells.get(cursor/volume); int offset=cursor%volume;
                    int x=offset%(plan.width+2), z=(offset/(plan.width+2))%(plan.depth+2), y=offset/((plan.width+2)*(plan.depth+2));
                    Material block = y==0 ? plan.floor : y==plan.height+1 ? plan.roof : x==0 || x==plan.width+1 || z==0 || z==plan.depth+1 ? plan.walls : plan.at(new Point(x-1,y-1,z-1));
                    org.bukkit.block.Block target = plan.world.getBlockAt(c.x+x,c.y+y,c.z+z);
                    target.setType(block,false);
                    if (target.getState() instanceof Container) {
                        Container empty = (Container)target.getState(); empty.getSnapshotInventory().clear(); empty.update(true,false);
                    }
                }
                if (cursor == total) {
                    for (Point c : plan.cells) {
                        for (Stock stock : plan.stocks) {
                            Container container=(Container)plan.world.getBlockAt(plan.position(c,stock.position)).getState();
                            container.getSnapshotInventory().clear();
                            for (Map.Entry<Integer,ItemStack> item : stock.items.entrySet()) container.getSnapshotInventory().setItem(item.getKey(),item.getValue().clone());
                            container.update(true,false);
                        }
                        for (Mob mob : plan.mobs) for (int i=0;i<mob.count;i++) {
                            Entity entity=plan.world.spawnEntity(plan.position(c,mob.position),mob.type);
                            entity.addScoreboardTag("rlcraft.arena."+plan.run);
                        }
                    }
                    ready.put(plan.run,plan); finish(null);
                }
            } catch (Exception error) { finish(String.valueOf(error.getMessage())); }
        }
        void finish(String error) {
            if (!active()) return;
            jobs.remove(plan.run); if (task!=null) task.cancel(); if (deadline!=null) deadline.cancel();
            for (Map.Entry<UUID,Boolean> entry : protectedPlayers.entrySet()) { Player player=Bukkit.getPlayer(entry.getKey()); if (player!=null && !viewer.test(player)) { player.setInvulnerable(entry.getValue()); player.setFallDistance(0); } }
            for (Point chunk : held) {
                String key=ticket(chunk); int count=tickets.getOrDefault(key,1)-1;
                if (count<=0) { tickets.remove(key); plan.world.removePluginChunkTicket(chunk.x,chunk.z,plugin); } else tickets.put(key,count);
            }
            result(request,error);
        }
    }
}
