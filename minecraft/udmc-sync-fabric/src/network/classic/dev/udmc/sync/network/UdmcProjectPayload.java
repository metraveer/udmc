package dev.udmc.sync.network;

import dev.udmc.sync.AgentLoginProtocol;
import dev.udmc.sync.ClientProject;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

/**
 * What the server is, told to a joining client that arrived knowing nothing.
 *
 * <p>A separate payload rather than more fields on the question: clients from 0.19.0 decode the
 * question by position and would choke on a longer one. They do not know this channel at all, so
 * it is discarded on their side and they still reach the screen that tells them what to install.
 */
public record UdmcProjectPayload(ClientProject.Offer offer) implements CustomPacketPayload {
    public static final ResourceLocation ID = ResourceLocation.fromNamespaceAndPath("udmc_sync", "verify_project");
    public static final CustomPacketPayload.Type<UdmcProjectPayload> TYPE = new CustomPacketPayload.Type<>(ID);
    public static final StreamCodec<FriendlyByteBuf, UdmcProjectPayload> CODEC =
        CustomPacketPayload.codec(UdmcProjectPayload::write, UdmcProjectPayload::new);

    public UdmcProjectPayload(FriendlyByteBuf input) {
        this(read(input));
    }

    private static ClientProject.Offer read(FriendlyByteBuf input) {
        input.readVarInt();
        return new ClientProject.Offer(input.readUtf(64), input.readUtf(128), input.readUtf(2048), input.readUtf(256));
    }

    public void write(FriendlyByteBuf output) {
        output.writeVarInt(AgentLoginProtocol.PROTOCOL);
        output.writeUtf(offer.packId(), 64);
        output.writeUtf(offer.packName(), 128);
        output.writeUtf(offer.apiUrl(), 2048);
        output.writeUtf(offer.publicKey(), 256);
    }

    @Override public CustomPacketPayload.Type<? extends CustomPacketPayload> type() { return TYPE; }
}
