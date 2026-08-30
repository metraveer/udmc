package dev.udmc.sync;

import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.util.Comparator;

public final class FabricServerLifecycleTest {
    public static void main(String[] args) throws Exception {
        var root = Files.createTempDirectory("udmc-fabric-lifecycle-");
        try (var occupied = new ServerSocket(); var http = HttpClient.newHttpClient()) {
            occupied.bind(new InetSocketAddress("127.0.0.1", 0));
            var config = new UdmcConfig();
            config.apiHost = "127.0.0.1";
            config.apiPort = occupied.getLocalPort();
            config.adminToken = "test-fabric-lifecycle-only";
            UdmcServerEntrypoint.prepare(root, config);
            // Preparing during loader initialization must not bind an HTTP port.
            try {
                UdmcServerEntrypoint.attachServer(null);
                throw new AssertionError("An API bind failure must fail server startup");
            } catch (IllegalStateException expected) {
                if (!(expected.getCause() instanceof java.io.IOException)) throw expected;
            }
            occupied.close();
            UdmcServerEntrypoint.attachServer(null);
            var response = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + config.apiPort + "/health")).GET().build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) throw new AssertionError("API did not start");
            UdmcServerEntrypoint.stopServer();
            UdmcServerEntrypoint.stopServer();
            try (var rebound = new ServerSocket()) { rebound.bind(new InetSocketAddress("127.0.0.1", config.apiPort)); }
            System.out.println("Fabric lifecycle passed: deferred API startup, fail-closed bind error, cleanup and released port.");
        } finally {
            UdmcServerEntrypoint.stopServer();
            try (var paths = Files.walk(root)) { for (var file : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(file); }
        }
    }
}
