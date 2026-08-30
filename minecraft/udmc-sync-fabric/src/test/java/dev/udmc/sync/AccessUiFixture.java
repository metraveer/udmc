package dev.udmc.sync;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;

/** Isolated loopback fixture for inspecting native Control; no Minecraft installation is touched. */
public final class AccessUiFixture {
    public static void main(String[] args) throws Exception {
        var root = Files.createTempDirectory("udmc-access-ui-");
        var config = new UdmcConfig();
        config.apiHost = "127.0.0.1"; config.apiPort = 0; config.adminToken = "udmc-ui-fixture-only";
        config.packName = "UDMC UI Test";
        var grants = new AdminAccess(root, config);
        var recovery = grants.authenticate(config.adminToken, "127.0.0.1");
        var invitation = grants.invite(recovery, "127.0.0.1");
        grants.request((String) invitation.get("code"), "f".repeat(64), "Test friend computer", "192.0.2.20");
        var api = new UdmcHttpApi(root, config, new ManifestStore(root, config));
        var stopped = new CountDownLatch(1);
        var control = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        control.createContext("/stop", exchange -> {
            if (!"POST".equals(exchange.getRequestMethod())) { exchange.sendResponseHeaders(405, -1); exchange.close(); return; }
            exchange.sendResponseHeaders(204, -1); exchange.close(); stopped.countDown();
        });
        try {
            api.start(); control.start();
            System.out.println("UI_FIXTURE_URL=http://127.0.0.1:" + api.port() + "/");
            System.out.println("UI_FIXTURE_STOP=http://127.0.0.1:" + control.getAddress().getPort() + "/stop");
            stopped.await();
        } finally {
            api.stop(); control.stop(0);
            TestMods.deleteTree(root);
        }
    }
}
