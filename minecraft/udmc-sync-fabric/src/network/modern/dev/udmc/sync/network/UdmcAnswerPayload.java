package dev.udmc.sync.network;

import dev.udmc.sync.AgentLoginProtocol;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;

/** What the player's client answers about itself. */
public record UdmcAnswerPayload(AgentLoginProtocol.Answer answer) implements CustomPacketPayload {
    public static final Identifier ID = Identifier.fromNamespaceAndPath("udmc_sync", "verify_answer");
    public static final CustomPacketPayload.Type<UdmcAnswerPayload> TYPE = new CustomPacketPayload.Type<>(ID);
    public static final StreamCodec<FriendlyByteBuf, UdmcAnswerPayload> CODEC =
        CustomPacketPayload.codec(UdmcAnswerPayload::write, UdmcAnswerPayload::new);

    public UdmcAnswerPayload(FriendlyByteBuf input) {
        this(new AgentLoginProtocol.Answer(input.readVarInt(), input.readUtf(64), input.readUtf(32), input.readUtf(64)));
    }

    public void write(FriendlyByteBuf output) {
        output.writeVarInt(answer.protocol());
        output.writeUtf(answer.packId(), 64);
        output.writeUtf(answer.version(), 32);
        output.writeUtf(answer.jarHash(), 64);
    }

    @Override public CustomPacketPayload.Type<? extends CustomPacketPayload> type() { return TYPE; }
}
