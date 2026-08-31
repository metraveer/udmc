package dev.udmc.sync;

import dev.udmc.sync.network.UdmcAnswerPayload;
import dev.udmc.sync.network.UdmcProjectPayload;
import dev.udmc.sync.network.UdmcQueryPayload;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.common.ClientboundCustomPayloadPacket;
import net.minecraft.network.protocol.configuration.ServerConfigurationPacketListener;
import net.minecraft.server.network.ConfigurationTask;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.network.event.RegisterConfigurationTasksEvent;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforge.network.registration.PayloadRegistrar;

import java.util.function.Consumer;

/**
 * The same check as on Fabric, carried by NeoForge's own payload registry instead of mixins.
 * Nothing here races another mod, and that is not merely tidier: on NeoForge an unregistered
 * payload is a hard kick with NeoForge's own wording, so a mixin that lost an ordering race
 * would turn a correctly installed player away with someone else's message.
 */
final class NeoForgeVerification {
    // Matched pairs are version-compared even when optional, so this literal must never
    // change: a mismatch replaces our notice with NeoForge's "incompatible" screen. Protocol
    // changes travel inside the payload, where UDMC can explain them.
    private static final String CHANNEL_VERSION = "1";
    private static final ConfigurationTask.Type TASK = new ConfigurationTask.Type(UdmcSync.MOD_ID + ":verify");

    private NeoForgeVerification() {}

    static void register(IEventBus modBus) {
        modBus.addListener(NeoForgeVerification::payloads);
        modBus.addListener(NeoForgeVerification::tasks);
    }

    private static void payloads(RegisterPayloadHandlersEvent event) {
        // Optional on purpose: a player without UDMC has to reach the check and read why they
        // were turned away, not be dropped by the loader before it runs.
        PayloadRegistrar registrar = event.registrar(CHANNEL_VERSION).optional();
        registrar.configurationToClient(UdmcQueryPayload.TYPE, UdmcQueryPayload.CODEC, (payload, context) -> {
            AgentLoginProtocol.Answer answer = AgentLoginProtocol.answer(payload.query());
            if (answer != null) context.reply(new UdmcAnswerPayload(answer));
        });
        registrar.configurationToClient(UdmcProjectPayload.TYPE, UdmcProjectPayload.CODEC,
            (payload, context) -> AgentLoginProtocol.offered(payload.offer()));
        registrar.configurationToServer(UdmcAnswerPayload.TYPE, UdmcAnswerPayload.CODEC, (payload, context) -> {
            AgentLoginProtocol.receive(context.connection(), payload.answer());
            if (context.listener() instanceof ServerConfigurationPacketListener listener) verdict(listener);
        });
    }

    private static void tasks(RegisterConfigurationTasksEvent event) {
        if (!AgentLoginProtocol.enabled()) return;
        ServerConfigurationPacketListener listener = event.getListener();
        event.register(new ConfigurationTask() {
            @Override public void start(Consumer<Packet<?>> sender) {
                // A client that never registered the channel cannot answer at all: decide now
                // rather than hold the phase open for a reply that is not coming.
                if (!listener.hasChannel(UdmcQueryPayload.TYPE)) { verdict(listener); return; }
                AgentLoginProtocol.asked(listener.getConnection());
                // Checked separately: sending a payload a client never registered is a hard kick
                // on NeoForge, and a client from before this channel has the question but not it.
                var project = AgentLoginProtocol.project();
                if (project != null && listener.hasChannel(UdmcProjectPayload.TYPE)) {
                    sender.accept(new ClientboundCustomPayloadPacket(new UdmcProjectPayload(project)));
                }
                sender.accept(new ClientboundCustomPayloadPacket(new UdmcQueryPayload(AgentLoginProtocol.query())));
            }

            @Override public ConfigurationTask.Type type() { return TASK; }
        });
    }

    /** Reached while the player is still configuring, where a disconnect reason still reads. */
    private static void verdict(ServerConfigurationPacketListener listener) {
        AgentLoginProtocol.pending(listener.getConnection());
        AgentLoginProtocol.Decision decision =
            AgentLoginProtocol.validate(AgentLoginProtocol.takeAnswer(listener.getConnection()));
        if (decision.reject()) {
            listener.disconnect(AgentLoginNotice.component(decision));
            return;
        }
        // The notice waits for the player to be in the world, where they can read and act on it.
        if (!decision.valid()) AgentLoginProtocol.warn(listener.getConnection(), decision);
        listener.finishCurrentTask(TASK);
    }
}
