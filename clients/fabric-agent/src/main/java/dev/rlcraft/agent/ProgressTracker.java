package dev.rlcraft.agent;
import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.item.ItemStack;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.registry.Registry;
import net.minecraft.block.BlockState;
import net.minecraft.state.property.Property;

/** Administrative evidence only; the policy receives its selected inputs. */
public final class ProgressTracker {
    public String origin = "existing";
    private final JsonArray steps;
    private final Set<String> sent = new HashSet<>();
    private JsonArray pending = new JsonArray();
    private final Set<String> advancements = new HashSet<>();
    private final Map<String,Integer> statistics = new HashMap<>();
    private final Set<String> existingAdvancements = new HashSet<>();
    private boolean nether, end, won, firstStats = true;
    private long lastSample, lastStatistics;
    public ProgressTracker() {
        try (InputStream stream = getClass().getResourceAsStream("/progression-catalog.json")) {
            steps = JsonParser.parseReader(new InputStreamReader(stream, StandardCharsets.UTF_8)).getAsJsonObject().getAsJsonArray("steps");
        } catch (Exception error) { throw new IllegalStateException("Missing progression catalog", error); }
    }
    public void advancement(String id, boolean completed, boolean existing) {
        if (completed) { advancements.add(id); if (existing) existingAdvancements.add(id); }
        else { advancements.remove(id); existingAdvancements.remove(id); }
    }
    public void clearAdvancements() { advancements.clear(); existingAdvancements.clear(); }
    public void statistic(String category, String name, int count) { statistics.put(category + ":" + name, count); }
    public void statsArrived() {
        if (firstStats) { evaluateStatistics("existing"); firstStats = false; }
        else evaluateStatistics(origin);
    }
    private void evaluateStatistics(String evidenceOrigin) {
        for (JsonElement value : steps) { JsonObject step = value.getAsJsonObject(); for (JsonElement r : step.getAsJsonArray("rules")) { JsonObject rule = r.getAsJsonObject(); if (!rule.get("kind").getAsString().equals("statistic")) continue;
            int total=0; for (JsonElement name:rule.getAsJsonArray("names")) total += statistics.getOrDefault(rule.get("category").getAsString()+":"+name.getAsString(),0);
            if (total >= (rule.has("count") ? rule.get("count").getAsInt() : 1)) emit(step.get("id").getAsString(), "statistic", "Received player statistic: " + rule.get("category").getAsString(), evidenceOrigin);
        } }
    }
    public void win() { if (end) won = true; }
    private void emit(String id, String source, String detail, String evidenceOrigin) {
        MinecraftClient c = MinecraftClient.getInstance(); if (c.player == null || c.interactionManager == null) return;
        String mode = c.interactionManager.getCurrentGameMode().getName(), key=id+":"+mode+":"+evidenceOrigin;
        if (!sent.add(key)) return;
        JsonObject item=new JsonObject(); item.addProperty("milestoneId",id); item.addProperty("at",System.currentTimeMillis()); item.addProperty("source",source); item.addProperty("detail",detail); item.addProperty("origin",evidenceOrigin); item.addProperty("gameMode",mode); pending.add(item);
    }
    public JsonArray drain() { JsonArray result=pending; pending=new JsonArray(); return result; }
    public void sample(MinecraftClient c) {
        long now=System.currentTimeMillis(); if (now-lastSample<500 || c.player==null || c.world==null) return; lastSample=now;
        if (now-lastStatistics>=10000 && c.getNetworkHandler()!=null) { lastStatistics=now; c.getNetworkHandler().sendPacket(new net.minecraft.network.packet.c2s.play.ClientStatusC2SPacket(net.minecraft.network.packet.c2s.play.ClientStatusC2SPacket.Mode.REQUEST_STATS)); }
        String dimension=c.world.getRegistryKey().getValue().getPath(); if (dimension.equals("the_end")) end=true; if(dimension.equals("the_nether")) nether=true;
        Map<String,Integer> inventory=new HashMap<>(); for(int i=0;i<c.player.getInventory().size();i++) { ItemStack s=c.player.getInventory().getStack(i); if(!s.isEmpty()) inventory.merge(Registry.ITEM.getId(s.getItem()).getPath(),s.getCount(),Integer::sum); }
        for(JsonElement value:steps) { JsonObject step=value.getAsJsonObject(); String id=step.get("id").getAsString(); for(JsonElement r:step.getAsJsonArray("rules")) { JsonObject rule=r.getAsJsonObject(); String kind=rule.get("kind").getAsString(); boolean match=false;
            if(kind.equals("inventory")) { int count=0; for(Map.Entry<String,Integer> item:inventory.entrySet()) { boolean fits=rule.has("suffix") && item.getKey().endsWith(rule.get("suffix").getAsString()); if(rule.has("items")) for(JsonElement name:rule.getAsJsonArray("items")) if(name.getAsString().equals(item.getKey())) fits=true; if(fits) count+=item.getValue(); } match=count>=(rule.has("count")?rule.get("count").getAsInt():1); }
            else if(kind.equals("advancement")) match=advancements.contains(rule.get("id").getAsString());
            else if(kind.equals("dimension")) { String name=rule.get("name").getAsString(); match=name.equals(dimension) || (name.equals("overworld_after_nether") && dimension.equals("overworld") && nether); }
            else if(kind.equals("credits")) match=won;
            else if(kind.equals("end-return")) match=won && end && dimension.equals("overworld");
            else if(kind.equals("window") && c.player.currentScreenHandler != c.player.playerScreenHandler) match=Registry.SCREEN_HANDLER.getId(c.player.currentScreenHandler.getType()).getPath().contains(rule.get("type").getAsString());
            else if(kind.equals("block")) { if ((Set.of("exit-portal","reach-island").contains(id) && !dimension.equals("the_end")) || (Set.of("active-end-portal","portal-room","insert-eye").contains(id) && !dimension.equals("overworld"))) continue;
                BlockPos center=c.player.getBlockPos(); for(BlockPos pos:BlockPos.iterate(center.add(-2,-2,-2),center.add(2,2,2))) { if(!c.world.isChunkLoaded(pos)) continue; BlockState state=c.world.getBlockState(pos); String name=Registry.BLOCK.getId(state.getBlock()).getPath(); boolean found=false; for(JsonElement n:rule.getAsJsonArray("names")) if(n.getAsString().equals(name)) found=true; if(!found) continue;
                    if(rule.has("properties")) for(Map.Entry<String,JsonElement> property:rule.getAsJsonObject("properties").entrySet()) { Property<?> p=state.getBlock().getStateManager().getProperty(property.getKey()); if(p==null || !String.valueOf(state.get(p)).equals(property.getValue().getAsString())) found=false; } if(found) {match=true;break;}
                }
            }
            if(match) emit(id,kind,"Observed " + kind + " evidence from the ordinary Fabric client",kind.equals("advancement") && existingAdvancements.contains(rule.get("id").getAsString())?"existing":origin);
        } }
    }
}
