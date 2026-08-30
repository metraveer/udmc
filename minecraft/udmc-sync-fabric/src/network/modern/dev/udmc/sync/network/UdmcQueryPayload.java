package dev.udmc.sync.network;

import dev.udmc.sync.AgentLoginProtocol;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.protocol.login.custom.CustomQueryPayload;
import net.minecraft.resources.Identifier;

public record UdmcQueryPayload(AgentLoginProtocol.Query query) implements CustomQueryPayload {
    public static final Identifier ID = Identifier.fromNamespaceAndPath("udmc_sync", "login");
    public UdmcQueryPayload(FriendlyByteBuf input) { this(new AgentLoginProtocol.Query(input.readVarInt(), input.readUtf(64), input.readUtf(64), input.readUtf(2048), input.readBoolean())); }
    @Override public Identifier id() { return ID; }
    @Override public void write(FriendlyByteBuf output) { output.writeVarInt(query.protocol()); output.writeUtf(query.packId(), 64); output.writeUtf(query.clientHash(), 64); output.writeUtf(query.downloadUrl(), 2048); output.writeBoolean(query.required()); }
}
