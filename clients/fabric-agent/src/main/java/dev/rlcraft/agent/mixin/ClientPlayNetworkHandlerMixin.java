package dev.rlcraft.agent.mixin;
import dev.rlcraft.agent.AgentClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.network.packet.s2c.play.AdvancementUpdateS2CPacket;
import net.minecraft.network.packet.s2c.play.StatisticsS2CPacket;
import net.minecraft.network.packet.s2c.play.GameStateChangeS2CPacket;
import net.minecraft.stat.Stat;
import net.minecraft.stat.Stats;
import net.minecraft.util.registry.Registry;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
@Mixin(ClientPlayNetworkHandler.class)
public abstract class ClientPlayNetworkHandlerMixin {
    @Inject(method="onAdvancements", at=@At("TAIL")) private void advancement(AdvancementUpdateS2CPacket packet, CallbackInfo info) {
        if(AgentClient.INSTANCE==null) return;
        if(packet.shouldClearCurrent()) AgentClient.INSTANCE.progress().clearAdvancements();
        packet.getAdvancementIdsToRemove().forEach(id -> AgentClient.INSTANCE.progress().advancement(id.toString(),false,false));
        packet.getAdvancementsToProgress().forEach((id,progress) -> AgentClient.INSTANCE.progress().advancement(id.toString(),progress.isDone(),packet.shouldClearCurrent()));
    }
    @Inject(method="onStatistics", at=@At("TAIL")) private void statistics(StatisticsS2CPacket packet, CallbackInfo info) {
        if(AgentClient.INSTANCE==null) return;
        packet.getStatMap().forEach((stat,count) -> {
            String category=null;
            if(stat.getType()==Stats.MINED) category="mined"; else if(stat.getType()==Stats.CRAFTED) category="crafted"; else if(stat.getType()==Stats.USED) category="used"; else if(stat.getType()==Stats.PICKED_UP) category="picked_up"; else if(stat.getType()==Stats.KILLED) category="killed";
            if(category!=null) AgentClient.INSTANCE.progress().statistic(category,statName(stat),count);
        }); AgentClient.INSTANCE.progress().statsArrived();
    }
    @Inject(method="onGameStateChange", at=@At("TAIL")) private void state(GameStateChangeS2CPacket packet, CallbackInfo info) {
        if(AgentClient.INSTANCE!=null && packet.getReason()==GameStateChangeS2CPacket.GAME_WON) AgentClient.INSTANCE.progress().win();
    }
    private static <T> String statName(Stat<T> stat) { return stat.getType().getRegistry().getId(stat.getValue()).getPath(); }
}
