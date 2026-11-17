package app.wareach.calls;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Sign in once, allow access, and see that calls are reaching WA Reach. */
public class MainActivity extends Activity {
    private static final int ASK_CALLS = 1;
    private static final int ASK_AUDIO = 2;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final SharedPreferences.OnSharedPreferenceChangeListener onChange = (sp, key) -> main.post(this::render);
    private Prefs prefs;
    private boolean busy;

    private View signin, status;
    private EditText server, email, password;
    private TextView signinError, connectedAs, permCalls, permRecordings, permBackground, lastSent, keptToday, syncError, update;
    private Button connect, allowCalls, allowRecordings, allowBackground, sendNow;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_main);
        prefs = new Prefs(this);

        View root = findViewById(R.id.root);
        if (Build.VERSION.SDK_INT >= 30) {
            // Keep content clear of the status and navigation bars (edge-to-edge on Android 15+).
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        }

        signin = findViewById(R.id.signin);
        status = findViewById(R.id.status);
        server = findViewById(R.id.server);
        email = findViewById(R.id.email);
        password = findViewById(R.id.password);
        signinError = findViewById(R.id.signin_error);
        connect = findViewById(R.id.connect);
        connectedAs = findViewById(R.id.connected_as);
        permCalls = findViewById(R.id.perm_calls);
        permRecordings = findViewById(R.id.perm_recordings);
        permBackground = findViewById(R.id.perm_background);
        allowCalls = findViewById(R.id.allow_calls);
        allowRecordings = findViewById(R.id.allow_recordings);
        allowBackground = findViewById(R.id.allow_background);
        lastSent = findViewById(R.id.last_sent);
        keptToday = findViewById(R.id.kept_today);
        syncError = findViewById(R.id.sync_error);
        sendNow = findViewById(R.id.send_now);
        update = findViewById(R.id.update);

        server.setText(prefs.server());
        connect.setOnClickListener(v -> signIn());
        allowCalls.setOnClickListener(v -> ask(Manifest.permission.READ_CALL_LOG, ASK_CALLS));
        allowRecordings.setOnClickListener(v -> ask(Sync.audioPermission(), ASK_AUDIO));
        allowBackground.setOnClickListener(v -> allowBackground());
        sendNow.setOnClickListener(v -> sendNow());
        findViewById(R.id.sign_out).setOnClickListener(v -> confirmSignOut());
        update.setOnClickListener(v -> {
            if (!prefs.appUrl().isEmpty()) startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(prefs.appUrl())));
        });
    }

    @Override
    protected void onStart() {
        super.onStart();
        prefs.raw().registerOnSharedPreferenceChangeListener(onChange);
    }

    @Override
    protected void onStop() {
        prefs.raw().unregisterOnSharedPreferenceChangeListener(onChange);
        super.onStop();
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
        if (prefs.signedIn()) {
            Scheduler.schedule(this);
            refreshAbout();
        }
    }

    @Override
    protected void onDestroy() {
        io.shutdown();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- sign in and out

    private void signIn() {
        String address = Api.normalizeServer(server.getText().toString());
        String user = email.getText().toString().trim();
        String pass = password.getText().toString();
        if (user.isEmpty() || pass.isEmpty()) {
            showSigninError(getString(R.string.error_fill));
            return;
        }
        busy = true;
        connect.setEnabled(false);
        connect.setText(R.string.connecting);
        signinError.setVisibility(View.GONE);
        io.execute(() -> {
            String error = null;
            try {
                JSONObject body = new JSONObject().put("email", user).put("password", pass).put("device", Sync.deviceName());
                JSONObject res = Api.json("POST", address, "/login", null, body);
                JSONObject who = res.getJSONObject("user");
                String name = who.optString("name", "");
                prefs.signIn(address, res.getString("token"), res.getString("business"), name.isEmpty() || "null".equals(name) ? who.getString("email") : name, res.getLong("since"));
                prefs.setAbout(res.getString("business"), prefs.userName(), res.optString("latestVersion", ""), res.optString("appUrl", ""));
            } catch (Api.ApiException e) {
                error = e.getMessage();
            } catch (Exception e) {
                error = getString(R.string.error_offline);
            }
            String failure = error;
            main.post(() -> {
                busy = false;
                connect.setEnabled(true);
                connect.setText(R.string.connect);
                if (failure != null) {
                    showSigninError(failure);
                    return;
                }
                password.setText("");
                render();
                if (!Sync.canReadCalls(this)) ask(Manifest.permission.READ_CALL_LOG, ASK_CALLS);
                else afterCallsAllowed();
            });
        });
    }

    private void showSigninError(String message) {
        signinError.setText(message);
        signinError.setVisibility(View.VISIBLE);
    }

    private void confirmSignOut() {
        new AlertDialog.Builder(this)
                .setMessage(R.string.sign_out_confirm)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.sign_out, (d, w) -> {
                    String address = prefs.server();
                    String token = prefs.token();
                    prefs.signOut();
                    Scheduler.cancel(this);
                    render();
                    io.execute(() -> {
                        try {
                            Api.json("POST", address, "/logout", token, null);
                        } catch (Exception ignored) {
                            // Signed out on this phone either way; WA Reach shows it stopped sending.
                        }
                    });
                })
                .show();
    }

    /** Business name, the person, and whether a newer app version is out. */
    private void refreshAbout() {
        io.execute(() -> {
            try {
                JSONObject res = Api.json("GET", prefs.server(), "/status", prefs.token(), null);
                JSONObject who = res.getJSONObject("user");
                String name = who.optString("name", "");
                prefs.setAbout(res.getString("business"), name.isEmpty() || "null".equals(name) ? who.getString("email") : name, res.optString("latestVersion", ""), res.optString("appUrl", ""));
            } catch (Api.ApiException e) {
                if (e.signedOut) {
                    prefs.signOut();
                    Scheduler.cancel(this);
                    prefs.failed(e.getMessage());
                }
            } catch (Exception ignored) {
                // Offline: the status shown stays as it was.
            }
        });
    }

    // ---------------------------------------------------------------- access

    private void ask(String permission, int code) {
        if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) return;
        // After "Don't allow" twice, Android stops asking: open the app's settings instead.
        if (getSharedPreferences("asked", MODE_PRIVATE).getBoolean(permission, false) && !shouldShowRequestPermissionRationale(permission)) {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
            return;
        }
        getSharedPreferences("asked", MODE_PRIVATE).edit().putBoolean(permission, true).apply();
        requestPermissions(new String[] {permission}, code);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        render();
        if (code == ASK_CALLS && Sync.canReadCalls(this)) afterCallsAllowed();
        if (code == ASK_AUDIO && Sync.canReadRecordings(this)) sendNow();
    }

    private void afterCallsAllowed() {
        Scheduler.schedule(this);
        sendNow();
        if (!Sync.canReadRecordings(this)) ask(Sync.audioPermission(), ASK_AUDIO);
    }

    private boolean runsInBackground() {
        PowerManager pm = getSystemService(PowerManager.class);
        return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    private void allowBackground() {
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    // ---------------------------------------------------------------- sending

    private void sendNow() {
        if (busy || !prefs.signedIn()) return;
        busy = true;
        sendNow.setEnabled(false);
        sendNow.setText(R.string.sending);
        io.execute(() -> {
            Sync.run(getApplicationContext());
            main.post(() -> {
                busy = false;
                sendNow.setEnabled(true);
                sendNow.setText(R.string.send_now);
                render();
            });
        });
    }

    // ---------------------------------------------------------------- screen

    private void render() {
        boolean in = prefs.signedIn();
        signin.setVisibility(in ? View.GONE : View.VISIBLE);
        status.setVisibility(in ? View.VISIBLE : View.GONE);
        if (!in) {
            String error = prefs.lastError();
            if (!error.isEmpty() && signinError.getVisibility() != View.VISIBLE) showSigninError(error);
            return;
        }
        connectedAs.setText(getString(R.string.connected_as, prefs.business(), prefs.userName()));

        boolean calls = Sync.canReadCalls(this);
        permCalls.setText(calls ? R.string.perm_calls_ok : R.string.perm_calls_needed);
        allowCalls.setVisibility(calls ? View.GONE : View.VISIBLE);
        boolean recordings = Sync.canReadRecordings(this);
        permRecordings.setText(recordings ? R.string.perm_recordings_ok : R.string.perm_recordings_needed);
        allowRecordings.setVisibility(recordings ? View.GONE : View.VISIBLE);
        boolean background = runsInBackground();
        permBackground.setText(background ? R.string.perm_background_ok : R.string.perm_background_needed);
        allowBackground.setVisibility(background ? View.GONE : View.VISIBLE);

        long at = prefs.lastSyncAt();
        lastSent.setText(at == 0 ? getString(R.string.never_sent) : getString(R.string.last_sent, Time.ago(at)));
        keptToday.setText(getString(R.string.kept_today, prefs.keptToday()));
        String error = prefs.lastError();
        syncError.setText(error);
        syncError.setVisibility(error.isEmpty() ? View.GONE : View.VISIBLE);

        String latest = prefs.latestVersion();
        boolean newer = !latest.isEmpty() && !prefs.appUrl().isEmpty() && isNewer(latest, BuildConfig.VERSION_NAME);
        update.setText(getString(R.string.update_available, latest));
        update.setVisibility(newer ? View.VISIBLE : View.GONE);
    }

    /** "1.2.0" is newer than "1.1.9". */
    static boolean isNewer(String a, String b) {
        String[] x = a.split("\\.");
        String[] y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? parse(x[i]) : 0;
            int q = i < y.length ? parse(y[i]) : 0;
            if (p != q) return p > q;
        }
        return false;
    }

    private static int parse(String s) {
        try {
            return Integer.parseInt(s.replaceAll("\\D", ""));
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
