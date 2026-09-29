package dev.rlcraft.agent;

import com.google.gson.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.client.gui.screen.ConnectScreen;
import net.minecraft.client.network.ServerAddress;
import net.minecraft.client.network.ServerInfo;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.util.ScreenshotRecorder;
import net.minecraft.item.ItemStack;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.registry.Registry;
import org.lwjgl.glfw.GLFW;

/** One ordinary Minecraft player connection. All world/control work stays on
 * the client thread. The private RPC socket never knows the control API token. */
public final class AgentClient implements ClientModInitializer {
    public static AgentClient INSTANCE;
    private static final Gson GSON = new Gson();
    private final String token = System.getenv("RLCRAFT_RPC_TOKEN");
    private JsonObject controls = new JsonObject();
    private JsonObject settings = new JsonObject();
    private boolean configured, digging;
    private long lastAction, lastCapture, frameSequence, inputSequence;
    private JsonObject latestFrame;
    private final ProgressTracker progress = new ProgressTracker();
    private final Map<String, JsonObject> cached = new HashMap<>();
    private JsonObject profile = new JsonObject();

    @Override public void onInitializeClient() {
        if (token == null || token.length() < 32) throw new IllegalStateException("Managed client requires a private RPC session");
        INSTANCE = this;
        Thread thread = new Thread(this::serve, "rlcraft-agent-rpc");
        thread.setDaemon(true); thread.start();
    }
    private void serve() {
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            Path ready = Path.of(System.getenv("RLCRAFT_READY_FILE"));
            JsonObject notice = new JsonObject(); notice.addProperty("protocol", 1); notice.addProperty("port", server.getLocalPort());
            Files.writeString(ready, GSON.toJson(notice), StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
            // The first authenticated parent owns the session. An unauthenticated
            // local connection is rejected without stopping the game process.
            while (true) {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(15000);
                    Reader reader = new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8);
                    Writer writer = new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8);
                    boolean authenticated = false;
                    while (true) {
                        String line = boundedLine(reader);
                        if (line == null) break;
                        JsonObject request = JsonParser.parseString(line).getAsJsonObject();
                        if (!request.has("token") || !java.security.MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), request.get("token").getAsString().getBytes(StandardCharsets.UTF_8))) break;
                        authenticated = true;
                        JsonObject reply = new JsonObject(); reply.addProperty("protocol", 1); reply.add("id", request.get("id"));
                        try {
                            CompletableFuture<JsonElement> result = new CompletableFuture<>();
                            MinecraftClient.getInstance().execute(() -> {
                                try { result.complete(handle(request.get("method").getAsString(), request.getAsJsonObject("params"))); }
                                catch (Throwable error) { result.completeExceptionally(error); }
                            });
                            reply.add("result", result.get(10, TimeUnit.SECONDS));
                        } catch (Exception error) { reply.addProperty("error", Objects.toString(error.getCause() != null ? error.getCause().getMessage() : error.getMessage(), "Client RPC failed")); }
                        writer.write(GSON.toJson(reply)); writer.write('\n'); writer.flush();
                    }
                    if (authenticated) { MinecraftClient.getInstance().scheduleStop(); return; }
                } catch (SocketTimeoutException error) {
                    MinecraftClient.getInstance().scheduleStop(); return;
                }
            }
        } catch (Exception error) { error.printStackTrace(); MinecraftClient.getInstance().scheduleStop(); }
    }
    private static String boundedLine(Reader reader) throws IOException {
        StringBuilder line = new StringBuilder();
        for (int c; (c = reader.read()) != -1;) {
            if (c == '\n') return line.toString();
            if (line.length() >= 65536) throw new IOException("Client request exceeds 64 KiB");
            line.append((char)c);
        }
        return line.length() == 0 ? null : line.toString();
    }
    private JsonElement handle(String method, JsonObject params) {
        MinecraftClient c = MinecraftClient.getInstance();
        switch (method) {
            case "boot": { JsonObject boot = new JsonObject(); boot.addProperty("ready", c.getOverlay() == null && c.getWindow() != null); return boot; }
            case "connect":
                if (c.getOverlay() != null) throw new IllegalStateException("Initial game resources are still loading");
                if (configured) throw new IllegalStateException("Client is already connected");
                settings = params.getAsJsonObject("render"); profile = params.getAsJsonObject("inputs");
                configured = true; configure(c);
                String address = params.get("host").getAsString() + ":" + params.get("port").getAsInt();
                ConnectScreen.connect(new TitleScreen(), c, ServerAddress.parse(address), new ServerInfo("RLCraft training", address, false));
                return JsonNull.INSTANCE;
            case "status": {
                JsonObject status = new JsonObject(); status.addProperty("connected", c.player != null && c.world != null && c.world.isChunkLoaded(c.player.getBlockPos()));
                status.addProperty("screen", c.currentScreen == null ? "" : c.currentScreen.getClass().getSimpleName());
                status.addProperty("renderError", renderError); return status;
            }
            case "observe": return snapshot(c, params.get("tick").getAsInt());
            case "setup-state": {
                requirePlayer(c); JsonObject state = new JsonObject(); JsonArray slots = new JsonArray();
                for(int i=0;i<c.player.getInventory().size();i++) {ItemStack stack=c.player.getInventory().getStack(i); JsonObject item=new JsonObject();item.addProperty("name",stack.isEmpty()?"air":Registry.ITEM.getId(stack.getItem()).getPath());item.addProperty("count",stack.getCount());slots.add(item);}
                state.add("slots",slots);state.addProperty("health",c.player.getHealth());state.addProperty("food",c.player.getHungerManager().getFoodLevel());state.addProperty("experienceLevel",c.player.experienceLevel);state.addProperty("heldSlot",c.player.getInventory().selectedSlot);state.addProperty("gamemode",c.interactionManager.getCurrentGameMode().getName());state.add("position",vector(c.player.getX(),c.player.getY(),c.player.getZ()));return state;
            }
            case "feed": return latestFrame == null ? JsonNull.INSTANCE : latestFrame.deepCopy();
            case "apply":
                requirePlayer(c);
                controls = params.has("controls") ? params.getAsJsonObject("controls").deepCopy() : new JsonObject();
                lastAction = System.currentTimeMillis(); digging = params.has("dig") && params.get("dig").getAsBoolean();
                if (params.has("look")) {
                    JsonObject look = params.getAsJsonObject("look");
                    // Common API uses Mineflayer radians: zero faces -Z, positive
                    // pitch points up. Vanilla yaw zero faces +Z, pitch down.
                    c.player.setYaw((float)(180 - Math.toDegrees(look.get("yaw").getAsDouble())));
                    c.player.setPitch((float)Math.max(-90, Math.min(90, -Math.toDegrees(look.get("pitch").getAsDouble()))));
                }
                return JsonNull.INSTANCE;
            case "clear": controls = new JsonObject(); digging = false; progress.origin = params.has("origin") ? params.get("origin").getAsString() : "live"; return JsonNull.INSTANCE;
            case "respawn": requirePlayer(c); if (c.player.isDead()) { c.player.requestRespawn(); c.setScreen(null); } return JsonNull.INSTANCE;
            case "close": controls = new JsonObject(); digging = false; c.scheduleStop(); return JsonNull.INSTANCE;
            default: throw new IllegalArgumentException("Unknown client RPC method");
        }
    }
    private void configure(MinecraftClient c) {
        c.options.pauseOnLostFocus = false; c.options.enableVsync = false;
        c.options.maxFps = Math.max(20, integer("fps", 10)); c.options.viewDistance = integer("viewDistance", 4);
        c.options.hudHidden = !bool("showHud", true); c.options.fov = 90;
        c.options.setPerspective(net.minecraft.client.option.Perspective.FIRST_PERSON);
        c.getWindow().setFramerateLimit(c.options.maxFps);
        if (!bool("visibleWindow", false)) GLFW.glfwHideWindow(c.getWindow().getHandle());
    }
    private int integer(String key, int fallback) { return settings.has(key) ? settings.get(key).getAsInt() : fallback; }
    private boolean bool(String key, boolean fallback) { return settings.has(key) ? settings.get(key).getAsBoolean() : fallback; }
    private static void requirePlayer(MinecraftClient c) { if (c.player == null || c.world == null) throw new IllegalStateException("Client player is not connected"); }
    private boolean pressed(String key) { return controls.has(key) && controls.get(key).getAsBoolean(); }
    public void tick() {
        if (!configured) return;
        MinecraftClient c = MinecraftClient.getInstance();
        if (System.currentTimeMillis() - lastAction > 2000) { controls = new JsonObject(); digging = false; }
        c.options.keyForward.setPressed(pressed("forward")); c.options.keyBack.setPressed(pressed("back"));
        c.options.keyLeft.setPressed(pressed("left")); c.options.keyRight.setPressed(pressed("right"));
        c.options.keyJump.setPressed(pressed("jump")); c.options.keySprint.setPressed(pressed("sprint")); c.options.keySneak.setPressed(pressed("sneak"));
        if (c.player == null || c.world == null) { latestFrame = null; return; }
        if (digging && c.crosshairTarget instanceof BlockHitResult && c.crosshairTarget.getType() == HitResult.Type.BLOCK && c.interactionManager != null) {
            BlockHitResult target = (BlockHitResult)c.crosshairTarget;
            if (c.interactionManager.updateBlockBreakingProgress(target.getBlockPos(), target.getSide())) c.player.swingHand(Hand.MAIN_HAND);
        } else if (c.interactionManager != null) c.interactionManager.cancelBlockBreaking();
        progress.sample(c);
    }
    private String renderError = "";
    public void rendered() {
        if (!configured) return;
        MinecraftClient c = MinecraftClient.getInstance();
        if (c.player == null || c.world == null) return;
        long now = System.currentTimeMillis();
        if (now - lastCapture < 1000 / integer("fps", 10)) return;
        lastCapture = now;
        try (NativeImage image = ScreenshotRecorder.takeScreenshot(c.getFramebuffer())) {
            int width = integer("width", 256), height = integer("height", 192);
            byte[] rgb = new byte[width * height * 3];
            for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
                int color = image.getColor(Math.min(image.getWidth()-1, x*image.getWidth()/width), Math.min(image.getHeight()-1, y*image.getHeight()/height));
                int at = (y * width + x) * 3; rgb[at] = (byte)NativeImage.getRed(color); rgb[at+1] = (byte)NativeImage.getGreen(color); rgb[at+2] = (byte)NativeImage.getBlue(color);
            }
            JsonObject frame = new JsonObject(); frame.addProperty("kind", "rgb"); frame.addProperty("encoding", "rgb8");
            frame.addProperty("sequence", ++frameSequence); frame.addProperty("capturedAt", now); frame.addProperty("width", width); frame.addProperty("height", height);
            frame.addProperty("data", Base64.getEncoder().encodeToString(rgb)); latestFrame = frame; renderError = "";
        } catch (Exception error) { latestFrame = null; renderError = Objects.toString(error.getMessage(), "Framebuffer capture failed"); }
    }
    private JsonObject sample(JsonElement data, String source, long now) {
        JsonObject result = new JsonObject(); result.addProperty("status", "ready"); result.addProperty("source", source); result.addProperty("sampledAt", now); result.add("data", data); return result;
    }
    private JsonObject snapshot(MinecraftClient c, int tick) {
        requirePlayer(c); long now = System.currentTimeMillis();
        JsonObject observation = new JsonObject(), inventory = new JsonObject();
        for (int i = 0; i < c.player.getInventory().size(); i++) {
            ItemStack stack = c.player.getInventory().getStack(i); if (stack.isEmpty()) continue;
            String name = Registry.ITEM.getId(stack.getItem()).getPath(); inventory.addProperty(name, (inventory.has(name) ? inventory.get(name).getAsInt() : 0) + stack.getCount());
        }
        JsonObject position = vector(c.player.getX(), c.player.getY(), c.player.getZ());
        observation.add("position", position); observation.addProperty("health", c.player.getHealth()); observation.addProperty("food", c.player.getHungerManager().getFoodLevel()); observation.add("inventory", inventory); observation.addProperty("tick", tick);
        JsonObject values = new JsonObject(), pose = new JsonObject(); pose.add("position", position.deepCopy()); pose.add("velocity", vector(c.player.getVelocity().x, c.player.getVelocity().y, c.player.getVelocity().z));
        pose.addProperty("yaw", Math.toRadians(180 - c.player.getYaw())); pose.addProperty("pitch", -Math.toRadians(c.player.getPitch())); pose.addProperty("onGround", c.player.isOnGround());
        values.add("self.pose", pose);
        JsonObject vitals = new JsonObject(); vitals.addProperty("health", c.player.getHealth()); vitals.addProperty("food", c.player.getHungerManager().getFoodLevel()); vitals.addProperty("saturation", c.player.getHungerManager().getSaturationLevel()); vitals.addProperty("oxygen", c.player.getAir()); vitals.addProperty("alive", !c.player.isDead()); values.add("self.vitals", vitals);
        JsonObject identity = new JsonObject(); identity.addProperty("username", c.player.getName().getString()); identity.addProperty("uuid", c.player.getUuidAsString()); identity.addProperty("id",c.player.getId());identity.addProperty("protocolVersion",757);identity.addProperty("version", "1.18.1"); values.add("self.identity", identity);
        JsonObject items = new JsonObject(); items.addProperty("quickBarSlot", c.player.getInventory().selectedSlot);items.addProperty("usingHeldItem",c.player.isUsingItem());
        JsonArray slots = new JsonArray(); for (int i=0;i<c.player.playerScreenHandler.slots.size();i++) slots.add(item(c.player.playerScreenHandler.getSlot(i).getStack(),i));items.add("slots",slots);items.add("heldItem",item(c.player.getMainHandStack(),36+c.player.getInventory().selectedSlot));JsonArray equipment=new JsonArray();for(ItemStack stack:c.player.getArmorItems())equipment.add(item(stack,-1));equipment.add(item(c.player.getOffHandStack(),45));items.add("equipment",equipment);values.add("self.inventory",items);
        JsonObject game = new JsonObject(); game.addProperty("dimension", c.world.getRegistryKey().getValue().getPath()); game.addProperty("gameMode", c.interactionManager == null ? "unknown" : c.interactionManager.getCurrentGameMode().getName()); values.add("world.game", game);
        JsonObject experience = new JsonObject(); experience.addProperty("level", c.player.experienceLevel); experience.addProperty("progress", c.player.experienceProgress); experience.addProperty("points", c.player.totalExperience); values.add("self.experience", experience);
        JsonObject controlState=new JsonObject();for(String key:List.of("forward","back","left","right","jump","sprint","sneak"))controlState.addProperty(key,pressed(key));values.add("self.controls",controlState);
        if (latestFrame != null && now - latestFrame.get("capturedAt").getAsLong() <= 2000) { JsonObject frame = new JsonObject(); frame.add("frame", latestFrame.deepCopy()); values.add("vision.rgb", frame); }
        JsonObject frame = new JsonObject(), channels = new JsonObject();
        for (Map.Entry<String, JsonElement> entry : profile.getAsJsonObject("channels").entrySet()) {
            JsonObject selection = entry.getValue().getAsJsonObject(); if (!selection.get("enabled").getAsBoolean()) continue;
            String id = entry.getKey(); JsonObject previous = cached.get(id);
            if (previous != null && now - previous.get("sampledAt").getAsLong() < selection.get("intervalMs").getAsLong()) { channels.add(id, previous.deepCopy()); continue; }
            JsonObject reading;
            if (values.has(id)) { reading = sample(values.get(id), id.equals("vision.rgb") ? "vanilla-framebuffer" : "client-received", id.equals("vision.rgb") ? latestFrame.get("capturedAt").getAsLong() : now); }
            else { reading = new JsonObject(); reading.addProperty("status", "unavailable"); reading.addProperty("source", "fabric-client"); reading.addProperty("sampledAt", now); reading.addProperty("reason", id.equals("vision.rgb") ? (renderError.isEmpty() ? "Waiting for a fresh rendered frame" : renderError) : "This Fabric adapter does not yet expose this channel"); }
            cached.put(id, reading.deepCopy()); channels.add(id, reading);
        }
        frame.addProperty("schemaVersion", 1); frame.addProperty("at", now); frame.addProperty("tick", tick); frame.addProperty("sequence", ++inputSequence); frame.add("channels", channels);
        JsonObject diagnostics = new JsonObject(); diagnostics.addProperty("droppedEvents", 0); diagnostics.addProperty("droppedBytes", 0); diagnostics.addProperty("eventBytes", 0); frame.add("diagnostics", diagnostics); observation.add("inputs", frame);
        JsonObject reply = new JsonObject(); reply.add("observation", observation); reply.add("progress", progress.drain()); return reply;
    }
    public static JsonObject vector(double x, double y, double z) { JsonObject v = new JsonObject(); v.addProperty("x", x); v.addProperty("y", y); v.addProperty("z", z); return v; }
    private static JsonElement item(ItemStack stack,int slot) {if(stack.isEmpty())return JsonNull.INSTANCE;JsonObject item=new JsonObject();item.addProperty("slot",slot);item.addProperty("name",Registry.ITEM.getId(stack.getItem()).getPath());item.addProperty("count",stack.getCount());item.addProperty("damage",stack.getDamage());if(stack.hasNbt())item.addProperty("nbt",stack.getNbt().toString());return item;}
    public ProgressTracker progress() { return progress; }
}
