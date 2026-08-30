package dev.udmc.sync.network;

import dev.udmc.sync.AgentLoginProtocol;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;

/** The question the server asks a joining player during the configuration phase. */
public record UdmcQueryPayload(AgentLoginProtocol.Query query) implements CustomPacketPayload {
    public static final Identifier ID = Identifier.fromNamespaceAndPath("udmc_sync", "verify_query");
    public static final CustomPacketPayload.Type<UdmcQueryPayload> TYPE = new CustomPacketPayload.Type<>(ID);
    public static final StreamCodec<FriendlyByteBuf, UdmcQueryPayload> CODEC =
        CustomPacketPayload.codec(UdmcQueryPayload::write, UdmcQueryPayload::new);

    public UdmcQueryPayload(FriendlyByteBuf input) {
        this(new AgentLoginProtocol.Query(input.readVarInt(), input.readUtf(64), input.readUtf(64), input.readUtf(2048), input.readBoolean()));
    }

    public void write(FriendlyByteBuf output) {
        output.writeVarInt(query.protocol());
        output.writeUtf(query.packId(), 64);
        output.writeUtf(query.clientHash(), 64);
        output.writeUtf(query.downloadUrl(), 2048);
        output.writeBoolean(query.required());
    }

    @Override public CustomPacketPayload.Type<? extends CustomPacketPayload> type() { return TYPE; }
}
