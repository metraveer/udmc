package dev.udmc.sync;

import dev.udmc.sync.update.AgentUpdateHelper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Properties;

public record AgentRelease(String body, String signature) {
    static AgentRelease sign(Path jar, String role, String version, long sequence, UdmcConfig config) throws IOException {
        Properties properties = new Properties();
        properties.setProperty("schema", "1");
        properties.setProperty("packId", config.packId);
        properties.setProperty("role", role);
        properties.setProperty("minecraft", config.minecraftVersion);
        properties.setProperty("loader", config.loaderType);
        properties.setProperty("version", version);
        properties.setProperty("sequence", Long.toString(sequence));
        properties.setProperty("sha256", Hashes.sha256(jar));
        properties.setProperty("size", Long.toString(Files.size(jar)));
        byte[] bytes = AgentUpdateHelper.bytes(properties);
        return new AgentRelease(Base64.getEncoder().encodeToString(bytes), ManifestSecurity.sign(bytes, config.manifestPrivateKey));
    }

    Properties verify(UdmcConfig config, String role) throws IOException {
        try {
            Properties result = AgentUpdateHelper.verify(body, signature, config.manifestPublicKey);
            if (!config.packId.equals(result.getProperty("packId")) || !role.equals(result.getProperty("role"))
                || !config.minecraftVersion.equals(result.getProperty("minecraft")) || !config.loaderType.equals(result.getProperty("loader"))) {
                throw Messages.error("udmc_sync.error.agent_signature");
            }
            return result;
        } catch (Messages.Failure error) { throw error; }
        catch (Exception error) { throw (IOException) Messages.error("udmc_sync.error.agent_signature").initCause(error); }
    }
}
