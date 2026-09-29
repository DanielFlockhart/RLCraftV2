package dev.rlcraft.agent.mixin;
import dev.rlcraft.agent.AgentClient;
import net.minecraft.client.MinecraftClient;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
@Mixin(MinecraftClient.class)
public abstract class MinecraftClientMixin {
    @Inject(method="tick", at=@At("HEAD")) private void agentTick(CallbackInfo info) { if (AgentClient.INSTANCE != null) AgentClient.INSTANCE.tick(); }
    @Inject(method="render", at=@At("TAIL")) private void agentFrame(boolean tick, CallbackInfo info) { if (AgentClient.INSTANCE != null) AgentClient.INSTANCE.rendered(); }
}
