package app.wareach.calls;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/** Talks to WA Reach's phone API (/device-api) over HTTPS. */
final class Api {
    private Api() {}

    static final class ApiException extends Exception {
        final int status;
        final boolean signedOut;

        ApiException(int status, String message, boolean signedOut) {
            super(message);
            this.status = status;
            this.signedOut = signedOut;
        }
    }

    /** "wa.example.com" becomes "https://wa.example.com"; a trailing slash is dropped. */
    static String normalizeServer(String input) {
        String s = input.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (!s.startsWith("https://") && !s.startsWith("http://")) s = "https://" + s;
        return s;
    }

    static JSONObject json(String method, String server, String path, String token, JSONObject body) throws IOException, ApiException {
        HttpURLConnection c = open(method, server, path, token);
        // A POST always carries a JSON body, even an empty one, so the server never guesses its type.
        if (body == null && "POST".equals(method)) body = new JSONObject();
        if (body != null) {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = c.getOutputStream()) {
                out.write(bytes);
            }
        }
        return read(c);
    }

    static JSONObject upload(String server, String path, String token, InputStream in, long length, String mime) throws IOException, ApiException {
        HttpURLConnection c = open("POST", server, path, token);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", mime == null || !mime.startsWith("audio/") ? "application/octet-stream" : mime);
        c.setFixedLengthStreamingMode(length);
        c.setReadTimeout(120_000);
        try (OutputStream out = c.getOutputStream()) {
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
        }
        return read(c);
    }

    private static HttpURLConnection open(String method, String server, String path, String token) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(server + "/device-api" + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(15_000);
        c.setReadTimeout(60_000);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("User-Agent", "WAReachCalls/" + BuildConfig.VERSION_NAME);
        if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }

    private static JSONObject read(HttpURLConnection c) throws IOException, ApiException {
        int status = c.getResponseCode();
        InputStream stream = status < 400 ? c.getInputStream() : c.getErrorStream();
        String text = "";
        if (stream != null) {
            try (InputStream in = stream) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int n;
                while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
                text = out.toString("UTF-8");
            }
        }
        c.disconnect();
        JSONObject body;
        try {
            body = text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } catch (JSONException e) {
            body = new JSONObject();
        }
        if (status >= 400) {
            String message = body.optString("error", "");
            if (message.isEmpty()) message = "WA Reach answered " + status + ". Check the address and try again.";
            throw new ApiException(status, message, body.optBoolean("signedOut", false));
        }
        return body;
    }
}
