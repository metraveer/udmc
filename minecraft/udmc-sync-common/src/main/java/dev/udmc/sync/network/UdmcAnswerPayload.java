package dev.udmc.sync.network;

import dev.udmc.sync.AgentLoginProtocol;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.protocol.login.custom.CustomQueryAnswerPayload;

public record UdmcAnswerPayload(AgentLoginProtocol.Answer answer) implements CustomQueryAnswerPayload {
    public UdmcAnswerPayload(FriendlyByteBuf input) {
        this(new AgentLoginProtocol.Answer(input.readVarInt(), input.readUtf(64), input.readUtf(32), input.readUtf(64)));
    }
    @Override public void write(FriendlyByteBuf output) {
        output.writeVarInt(answer.protocol()); output.writeUtf(answer.packId(), 64); output.writeUtf(answer.version(), 32); output.writeUtf(answer.jarHash(), 64);
    }
}
