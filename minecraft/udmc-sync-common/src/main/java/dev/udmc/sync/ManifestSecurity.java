package dev.udmc.sync;

import java.io.IOException;
import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

public final class ManifestSecurity {
    private ManifestSecurity() {
    }

    public static String sign(byte[] body, String privateKey) throws IOException {
        try {
            Signature signer = Signature.getInstance("Ed25519");
            signer.initSign(KeyFactory.getInstance("Ed25519").generatePrivate(
                new PKCS8EncodedKeySpec(Base64.getDecoder().decode(privateKey))));
            signer.update(body);
            return Base64.getEncoder().encodeToString(signer.sign());
        } catch (Exception error) {
            throw new IOException("Cannot sign manifest", error);
        }
    }

    public static void verify(byte[] body, String signature, String publicKey) throws IOException {
        if (signature == null || signature.isBlank() || publicKey == null || publicKey.isBlank()) {
            throw Messages.error("udmc_sync.error.signature_missing");
        }
        try {
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(KeyFactory.getInstance("Ed25519").generatePublic(
                new X509EncodedKeySpec(Base64.getDecoder().decode(publicKey))));
            verifier.update(body);
            if (!verifier.verify(Base64.getDecoder().decode(signature))) {
                throw Messages.error("udmc_sync.error.signature");
            }
        } catch (IOException error) {
            throw error;
        } catch (Exception error) {
            throw (IOException) Messages.error("udmc_sync.error.signature").initCause(error);
        }
    }
}
