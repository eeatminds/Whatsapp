package app.wareach.calls;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * A stand-in for WA Reach's phone API on 127.0.0.1, recording what the app sends. Plain sockets:
 * one request per connection, which is all the app's HttpURLConnection needs.
 */
final class FakeServer implements AutoCloseable {
    final List<String> calls = new CopyOnWriteArrayList<>();
    final List<String> paths = new CopyOnWriteArrayList<>();
    volatile long loginDelayMs = 0;
    /** What /calls answers with in recordingsWanted (JSON array). */
    volatile String wanted = "[]";
    /** Recordings received: "path content-type bytes". */
    final List<String> recordings = new CopyOnWriteArrayList<>();
    private final ServerSocket socket;

    FakeServer() throws IOException {
        socket = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        Thread accept = new Thread(() -> {
            while (!socket.isClosed()) {
                try {
                    Socket client = socket.accept();
                    new Thread(() -> serve(client), "fake-wa-reach").start();
                } catch (IOException closed) {
                    return;
                }
            }
        }, "fake-wa-reach-accept");
        accept.setDaemon(true);
        accept.start();
    }

    String address() {
        return "http://127.0.0.1:" + socket.getLocalPort();
    }

    private void serve(Socket client) {
        try (Socket c = client) {
            InputStream in = c.getInputStream();
            String requestLine = line(in);
            int length = 0;
            String type = "";
            for (String header = line(in); !header.isEmpty(); header = line(in)) {
                String lower = header.toLowerCase(Locale.ROOT);
                if (lower.startsWith("content-length:")) length = Integer.parseInt(header.substring(15).trim());
                if (lower.startsWith("content-type:")) type = header.substring(13).trim();
            }
            byte[] body = new byte[length];
            for (int read = 0; read < length; ) {
                int n = in.read(body, read, length - read);
                if (n < 0) break;
                read += n;
            }
            String path = requestLine.split(" ")[1].replaceFirst("^/device-api", "");
            paths.add(path);
            if (path.startsWith("/recordings/")) recordings.add(path + " " + type + " " + length);
            byte[] reply = reply(path, new String(body, StandardCharsets.UTF_8)).getBytes(StandardCharsets.UTF_8);
            OutputStream out = c.getOutputStream();
            out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + reply.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.write(reply);
            out.flush();
        } catch (IOException ignored) {
            // The app gave up on this request; nothing to record.
        }
    }

    private String reply(String path, String body) {
        switch (path) {
            case "/login":
                sleep(loginDelayMs);
                return "{\"token\":\"abc123.ABCDEFGHIJABCDEFGHIJABCDEFGHIJABCDEFGHIJ\",\"business\":\"Shreyas Naveen Tiles\","
                        + "\"user\":{\"name\":\"Naveen\",\"email\":\"naveen@example.com\"},\"since\":0,\"latestVersion\":\"" + BuildConfig.VERSION_NAME
                        + "\",\"appUrl\":\"https://wa.example.com/downloads/wa-reach-calls.apk\"}";
            case "/status":
                return "{\"ok\":true,\"business\":\"Shreyas Naveen Tiles\",\"user\":{\"name\":\"Naveen\",\"email\":\"naveen@example.com\"},\"latestVersion\":\""
                        + BuildConfig.VERSION_NAME + "\"}";
            case "/calls":
                calls.add(body);
                return "{\"stored\":1,\"ignored\":0,\"recordingsWanted\":" + wanted + "}";
            default:
                return "{\"ok\":true}";
        }
    }

    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int b = in.read(); b != -1 && b != '\n'; b = in.read()) {
            if (b != '\r') out.write(b);
        }
        return out.toString("US-ASCII");
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    @Override
    public void close() throws IOException {
        socket.close();
    }
}
