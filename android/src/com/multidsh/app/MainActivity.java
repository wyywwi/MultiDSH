package com.multidsh.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.text.TextUtils;
import android.util.Base64;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.KeyStore;
import java.util.Iterator;
import java.util.Locale;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * MultiDSH Android M2.1 shell.
 *
 * <p>One Activity, one WebView, one native top bar. The client UI itself is plain
 * HTML/CSS/JS in assets/multidsh/index.html. It is loaded with
 * {@code loadDataWithBaseURL(directoryUrl + "/")} so the page origin equals the
 * Directory origin and plain {@code fetch("/api/...")} is same-origin. Remote host
 * pages (DSH Web UI) are loaded in the same WebView with {@link WebView#loadUrl(String)},
 * which keeps CookieManager's {@code dsh-auth-*} cookies.
 *
 * <p>Native layout: {@code LinearLayout(vertical){ TopBar(48dp), FrameLayout(WebView) }}.
 * The page drives the bar through {@code MDNative.setUiMode(token, mode, title)} with
 * {@code mode in {home, pool, settings, host}}.
 *
 * <p>Security model (P0):
 * <ul>
 *   <li>A random bridge token is generated for every client page load and substituted for
 *       the {@code __MD_BRIDGE_TOKEN__} placeholder in the asset HTML. Every MDNative method
 *       takes the token as its first argument and rejects calls that do not carry it, so a
 *       remote host page (which never sees the client HTML/token) cannot use the bridge.</li>
 *   <li>The debug JS hook ({@code --es js} / {@code --es js_b64}) and
 *       {@code WebView.setWebContentsDebuggingEnabled} only work in a debuggable build.</li>
 *   <li>Cleartext HTTP is disabled by default (AndroidManifest usesCleartextTraffic=false +
 *       res/xml/network_security_config.xml); only localhost / 127.0.0.1 / 10.0.2.2 may use
 *       cleartext (local Directory and emulator/desktop host development).</li>
 *   <li>Logs never contain a full pair URL, query string, token or nonce: only
 *       scheme://host:port (see {@link #safeLabel(String)}) and status codes are logged.</li>
 *   <li>Mixed content is COMPATIBILITY_MODE (never ALWAYS_ALLOW).</li>
 * </ul>
 *
 * <p>Test hook (debuggable builds only): {@code adb shell am start -n com.multidsh.app/.MainActivity
 * --es js "..."} evaluates the given JS once after the current page finishes loading.
 */
public class MainActivity extends Activity {

    private static final String TAG = "MultiDSH";
    private static final String PREFS = "multidsh";
    private static final String DEFAULT_DIRECTORY = "https://multidsh.example.com";
    private static final String APP_VERSION = "0.2.0";

    private static final String MODE_HOME = "home";
    private static final String MODE_POOL = "pool";
    private static final String MODE_SETTINGS = "settings";
    private static final String MODE_HOST = "host";

    /** Replaced inside assets/multidsh/index.html on every client load. */
    private static final String BRIDGE_TOKEN_PLACEHOLDER = "__MD_BRIDGE_TOKEN__";

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int TOP_BAR_HEIGHT_DP = 48;
    private static final int SIDE_SLOT_WIDTH_DP = 64;
    private static final int MAX_HTTP_BODY = 8 * 1024 * 1024;

    private WebView web;
    private FrameLayout webContainer;
    private TextView topTitle;
    private TextView topBack;
    private TextView topSettings;
    private View topBar;
    private SharedPreferences prefs;

    /** Random per-client-load capability token; valid for every MDNative method. */
    private volatile String bridgeToken;

    /** Origin (scheme://host[:port]) of the local client page. */
    private String clientOrigin;

    /** One of MODE_HOME / MODE_POOL / MODE_SETTINGS / MODE_HOST. */
    private volatile String uiMode = MODE_HOME;

    private String currentHostLabel;

    /** True while the WebView is showing the local client page (informational). */
    private volatile boolean clientPageActive;

    /** Set when the native back button leaves host mode; consumed by onPageFinished. */
    private boolean pendingReturnToClient;

    /** Host-page failure to report after the local client page is reloaded. */
    private int pendingHostErrorCode;
    private String pendingHostErrorDescription;
    private String pendingHostErrorUrl;

    private String pendingJs;
    private boolean jsPending;
    private ValueCallback<Uri[]> fileChooserCallback;

    // ------------------------------------------------------------------
    // Activity lifecycle
    // ------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        // Debug surfaces are only enabled for debuggable (debug-signed) builds.
        if (isDebuggable()) {
            WebView.setWebContentsDebuggingEnabled(true);
            pendingJs = injectedJs(getIntent());
            jsPending = pendingJs != null;
        }

        setupWindowChrome();
        buildLayout();
        createWebView();
        loadClient(directoryUrl());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        final String script = injectedJs(intent);
        if (script == null) {
            return;
        }
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Log.i(TAG, "evaluate injected js (" + script.length() + " chars)");
                evaluate(script);
            }
        });
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        fileChooserCallback = null;
        if (web != null) {
            try {
                web.removeJavascriptInterface("MDNative");
            } catch (Exception ignored) {
                // Nothing to clean up if the interface was never added.
            }
            if (webContainer != null) {
                webContainer.removeView(web);
            }
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (MODE_HOST.equals(uiMode)) {
            // Native back in host mode is the closeHost path: return to the local client page.
            returnToClient();
            return;
        }
        if (MODE_POOL.equals(uiMode) || MODE_SETTINGS.equals(uiMode)) {
            onTopBarBack();
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    ClipData clip = data.getClipData();
                    int count = clip.getItemCount();
                    result = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        result[i] = clip.getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    result = new Uri[] { data.getData() };
                }
            }
            ValueCallback<Uri[]> callback = fileChooserCallback;
            fileChooserCallback = null;
            if (callback != null) {
                callback.onReceiveValue(result);
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ------------------------------------------------------------------
    // Native UI: status bar + top bar + WebView container
    // ------------------------------------------------------------------

    private void setupWindowChrome() {
        try {
            Window window = getWindow();
            window.setStatusBarColor(Color.WHITE);
            window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        } catch (Exception e) {
            Log.w(TAG, "status bar setup failed: " + describe(e));
        }
    }

    private void buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        root.addView(buildTopBar(),
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                        dp(TOP_BAR_HEIGHT_DP)));

        webContainer = new FrameLayout(this);
        webContainer.setBackgroundColor(Color.WHITE);
        root.addView(webContainer,
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
    }

    private View buildTopBar() {
        FrameLayout bar = new FrameLayout(this);
        topBar = bar;
        bar.setBackgroundColor(Color.WHITE);
        bar.setElevation(dp(2));

        topBack = topBarButton("返回");
        topBack.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onTopBarBack();
            }
        });
        FrameLayout.LayoutParams backLp =
                new FrameLayout.LayoutParams(dp(SIDE_SLOT_WIDTH_DP),
                        FrameLayout.LayoutParams.MATCH_PARENT);
        backLp.gravity = Gravity.START | Gravity.CENTER_VERTICAL;
        bar.addView(topBack, backLp);

        topSettings = topBarButton("设置");
        topSettings.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // The page owns the settings view; the native button only asks for it.
                evaluate("(function(){try{if(window.MDApp&&MDApp.openSettings){MDApp.openSettings();}}catch(e){}})()");
            }
        });
        FrameLayout.LayoutParams settingsLp =
                new FrameLayout.LayoutParams(dp(SIDE_SLOT_WIDTH_DP),
                        FrameLayout.LayoutParams.MATCH_PARENT);
        settingsLp.gravity = Gravity.END | Gravity.CENTER_VERTICAL;
        bar.addView(topSettings, settingsLp);

        topTitle = new TextView(this);
        topTitle.setText("MultiDSH");
        topTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        topTitle.setTextColor(Color.parseColor("#111827"));
        topTitle.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        topTitle.setGravity(Gravity.CENTER);
        topTitle.setSingleLine(true);
        topTitle.setEllipsize(TextUtils.TruncateAt.END);
        FrameLayout.LayoutParams titleLp =
                new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT);
        titleLp.leftMargin = dp(SIDE_SLOT_WIDTH_DP);
        titleLp.rightMargin = dp(SIDE_SLOT_WIDTH_DP);
        bar.addView(topTitle, titleLp);

        applyUiMode(MODE_HOME, "MultiDSH");
        return bar;
    }

    private TextView topBarButton(String label) {
        TextView view = new TextView(this);
        view.setText(label);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        view.setTextColor(Color.parseColor("#374151"));
        view.setGravity(Gravity.CENTER);
        view.setMinWidth(dp(48));
        view.setMinHeight(dp(TOP_BAR_HEIGHT_DP));
        view.setClickable(true);
        view.setFocusable(true);
        try {
            TypedValue out = new TypedValue();
            if (getTheme().resolveAttribute(android.R.attr.selectableItemBackground, out, true)
                    && out.resourceId != 0) {
                view.setBackgroundResource(out.resourceId);
            }
        } catch (Exception ignored) {
            // Ripple is cosmetic; a missing theme attribute is not fatal.
        }
        return view;
    }

    /**
     * Applies a top bar state. Called from the UI thread only.
     *
     * @param mode  home|pool|settings|host
     * @param title page supplied title, may be null/empty for the mode default
     */
    private void applyUiMode(String mode, String title) {
        if (topTitle == null || topBack == null || topSettings == null) {
            return;
        }
        if (MODE_POOL.equals(mode)) {
            uiMode = MODE_POOL;
            topBack.setVisibility(View.VISIBLE);
            topSettings.setVisibility(View.VISIBLE);
            topTitle.setText(hasText(title) ? title.trim() : "我的池");
        } else if (MODE_SETTINGS.equals(mode)) {
            uiMode = MODE_SETTINGS;
            topBack.setVisibility(View.VISIBLE);
            topSettings.setVisibility(View.GONE);
            topTitle.setText(hasText(title) ? title.trim() : "设置");
        } else if (MODE_HOST.equals(mode)) {
            uiMode = MODE_HOST;
            topBack.setVisibility(View.VISIBLE);
            topSettings.setVisibility(View.GONE);
            String fallback = hasText(currentHostLabel) ? currentHostLabel : "Host";
            topTitle.setText(hasText(title) ? title.trim() : fallback);
        } else {
            uiMode = MODE_HOME;
            topBack.setVisibility(View.GONE);
            topSettings.setVisibility(View.VISIBLE);
            topTitle.setText(hasText(title) ? title.trim() : "MultiDSH");
        }
    }

    private void applyTopBarTheme(String theme) {
        boolean dark = "dark".equals(theme);
        int barColor = dark ? Color.parseColor("#171b22") : Color.WHITE;
        int titleColor = dark ? Color.parseColor("#e8edf5") : Color.parseColor("#111827");
        int buttonColor = dark ? Color.parseColor("#c7d2e2") : Color.parseColor("#374151");
        if (topBar != null) topBar.setBackgroundColor(barColor);
        if (topTitle != null) topTitle.setTextColor(titleColor);
        if (topBack != null) topBack.setTextColor(buttonColor);
        if (topSettings != null) topSettings.setTextColor(buttonColor);
        if (web != null) web.setBackgroundColor(dark ? Color.parseColor("#0f1115") : Color.parseColor("#f4f6f9"));
        try {
            Window window = getWindow();
            window.setStatusBarColor(barColor);
            int flags = window.getDecorView().getSystemUiVisibility();
            if (dark) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            } else {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            }
            window.getDecorView().setSystemUiVisibility(flags);
        } catch (Exception ignored) {
            // Status bar color is cosmetic.
        }
    }

    private void onTopBarBack() {
        if (MODE_HOST.equals(uiMode)) {
            returnToClient();
            return;
        }
        if (MODE_POOL.equals(uiMode) || MODE_SETTINGS.equals(uiMode)) {
            // Fallback bar state; the page corrects it through setUiMode when it handles the back.
            applyUiMode(MODE_HOME, "MultiDSH");
            evaluate("(function(){try{if(window.MDApp){"
                    + "if(MDApp.onNativeBack&&MDApp.onNativeBack()){return;}"
                    + "if(MDApp.showHome){MDApp.showHome();}"
                    + "}}catch(e){}})()");
        }
        // home: there is nowhere to go back to inside the app (hardware back exits).
    }

    /** Leaves the remote host page and reloads the local client page (closeHost path). */
    private void returnToClient() {
        if (web == null) {
            return;
        }
        Log.i(TAG, "close host, back to client page");
        pendingReturnToClient = true;
        currentHostLabel = null;
        applyUiMode(MODE_HOME, "MultiDSH");
        loadClient(directoryUrl());
    }

    // ------------------------------------------------------------------
    // WebView setup
    // ------------------------------------------------------------------

    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // Never ALWAYS_ALLOW: an https client page must not silently pull in http content.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(true);
        settings.setSafeBrowsingEnabled(true);
        String userAgent = settings.getUserAgentString();
        settings.setUserAgentString((userAgent == null ? "" : userAgent)
                + " MultiDSH-Android/" + APP_VERSION);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "MDNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                Log.i(TAG, "download requested: " + safeLabel(url) + " (" + mimeType + ")");
                if (isHttpUrl(url)) {
                    openExternally(Uri.parse(url));
                }
            }
        });

        if (webContainer != null) {
            webContainer.addView(web,
                    new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                            FrameLayout.LayoutParams.MATCH_PARENT));
        }
    }

    /** Reads the asset client, injects a fresh bridge token and loads it same-origin. */
    private void loadClient(String directoryUrl) {
        if (web == null) {
            return;
        }
        String base = hasText(directoryUrl) ? directoryUrl.trim() : DEFAULT_DIRECTORY;
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        base = base + "/";

        String html = readAsset("multidsh/index.html");
        if (html == null) {
            html = "<html><body style='background:#fff;color:#b91c1c;font-family:sans-serif;padding:24px'>"
                    + "<h2>MultiDSH</h2><p>assets/multidsh/index.html missing from APK.</p>"
                    + "</body></html>";
        }

        String token = newBridgeToken();
        bridgeToken = token;
        clientOrigin = originOf(base);
        clientPageActive = true;

        String injected = html.replace(BRIDGE_TOKEN_PLACEHOLDER, token);
        web.loadDataWithBaseURL(base, injected, "text/html", "utf-8", null);
        Log.i(TAG, "client loaded for " + safeLabel(base));
    }

    private String readAsset(String path) {
        InputStream in = null;
        try {
            in = getAssets().open(path);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.e(TAG, "readAsset failed: " + describe(e));
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                    // Closing the asset stream is best effort.
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // WebViewClient: navigation policy, error pages, renderer recovery
    // ------------------------------------------------------------------

    private class Client extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (request == null) {
                return false;
            }
            Uri uri = request.getUrl();
            if (uri == null) {
                return false;
            }
            String scheme = lower(uri.getScheme());
            // Directory + host + pair URLs stay in this single WebView (cookies preserved).
            if ("http".equals(scheme) || "https".equals(scheme)) {
                return false;
            }
            if (!request.isForMainFrame()) {
                return false;
            }
            if ("mailto".equals(scheme) || "tel".equals(scheme)
                    || "sms".equals(scheme) || "smsto".equals(scheme)) {
                openExternally(uri);
                return true;
            }
            if ("intent".equals(scheme)) {
                openIntentUri(uri);
                return true;
            }
            // Unknown/custom schemes are not opened from remote content.
            Log.w(TAG, "blocked navigation to scheme '" + scheme + "'");
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (isClientUrl(url)) {
                clientPageActive = true;
                return;
            }
            clientPageActive = false;
            if (isHttpUrl(url)) {
                String host = hostLabel(url);
                if (host != null && !MODE_HOST.equals(uiMode)) {
                    currentHostLabel = host;
                    applyUiMode(MODE_HOST, host);
                }
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            Log.i(TAG, "page finished: " + safeLabel(url));
            if (isClientUrl(url)) {
                clientPageActive = true;
                try {
                    // Host pages are never reachable through history; back always means "go home".
                    view.clearHistory();
                } catch (Exception ignored) {
                    // clearHistory is best effort.
                }
                if (pendingReturnToClient) {
                    pendingReturnToClient = false;
                    evaluate("(function(){try{if(window.MDApp){"
                            + "if(MDApp.onHostClosed){MDApp.onHostClosed();}"
                            + "else if(MDApp.closeHost){MDApp.closeHost();}"
                            + "}}catch(e){}})()");
                }
                if (pendingHostErrorCode != 0) {
                    int errorCode = pendingHostErrorCode;
                    String errorDescription = pendingHostErrorDescription;
                    String errorUrl = pendingHostErrorUrl;
                    pendingHostErrorCode = 0;
                    pendingHostErrorDescription = null;
                    pendingHostErrorUrl = null;
                    notifyHostError(errorCode, errorDescription, errorUrl);
                }
            }
            if (jsPending && pendingJs != null) {
                jsPending = false;
                String script = pendingJs;
                pendingJs = null;
                Log.i(TAG, "evaluate injected js (" + script.length() + " chars)");
                evaluate(script);
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request,
                                    WebResourceError error) {
            if (request == null || !request.isForMainFrame()) {
                return;
            }
            String url = request.getUrl() == null ? "" : request.getUrl().toString();
            int code = 0;
            String description = "";
            if (error != null) {
                code = error.getErrorCode();
                CharSequence text = error.getDescription();
                description = text == null ? "" : text.toString();
            }
            Log.w(TAG, "main frame error " + code + " on " + safeLabel(url) + ": " + description);
            handleMainFrameFailure(code, description, url);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                        WebResourceResponse errorResponse) {
            if (request == null || !request.isForMainFrame() || errorResponse == null) {
                return;
            }
            String url = request.getUrl() == null ? "" : request.getUrl().toString();
            int status = errorResponse.getStatusCode();
            String reason = errorResponse.getReasonPhrase();
            Log.w(TAG, "main frame http " + status + " on " + safeLabel(url));
            handleMainFrameFailure(status, reason == null ? "" : reason, url);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            boolean crashed = detail != null && detail.didCrash();
            Log.e(TAG, "render process gone (crashed=" + crashed + "), recreating WebView");
            if (view != web) {
                return true;
            }
            fileChooserCallback = null;
            if (webContainer != null) {
                webContainer.removeView(view);
            }
            try {
                view.destroy();
            } catch (Exception ignored) {
                // The renderer is already gone.
            }
            web = null;
            if (webContainer != null) {
                webContainer.post(new Runnable() {
                    @Override
                    public void run() {
                        if (isFinishing() || isDestroyed()) {
                            return;
                        }
                        createWebView();
                        loadClient(directoryUrl());
                    }
                });
            }
            return true;
        }
    }

    // ------------------------------------------------------------------
    // WebChromeClient: console, popups, file chooser
    // ------------------------------------------------------------------

    private class Chrome extends WebChromeClient {

        @Override
        public boolean onConsoleMessage(ConsoleMessage message) {
            if (message != null) {
                Log.i(TAG, "console(" + message.messageLevel() + "): " + message.message());
            }
            return true;
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                      Message resultMsg) {
            // window.open()/target=_blank: load in the existing WebView instead of a second one.
            if (resultMsg == null || !(resultMsg.obj instanceof WebView.WebViewTransport)) {
                return false;
            }
            WebView target = web != null ? web : view;
            if (target == null) {
                return false;
            }
            ((WebView.WebViewTransport) resultMsg.obj).setWebView(target);
            resultMsg.sendToTarget();
            return true;
        }

        @Override
        public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                         FileChooserParams fileChooserParams) {
            if (fileChooserCallback != null) {
                fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = null;
            }
            fileChooserCallback = filePathCallback;
            try {
                Intent intent = fileChooserParams != null ? fileChooserParams.createIntent() : null;
                if (intent == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                }
                startActivityForResult(intent, REQ_FILE_CHOOSER);
                return true;
            } catch (Exception e) {
                Log.w(TAG, "file chooser failed: " + describe(e));
                fileChooserCallback = null;
                return false;
            }
        }
    }

    // ------------------------------------------------------------------
    // External intents / URL helpers
    // ------------------------------------------------------------------

    private void openExternally(Uri uri) {
        if (uri == null) {
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "no app for scheme '" + lower(uri.getScheme()) + "'");
        } catch (Exception e) {
            Log.w(TAG, "external intent failed: " + describe(e));
        }
    }

    private void openIntentUri(Uri uri) {
        Intent intent = null;
        try {
            intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            Log.w(TAG, "intent: uri failed: " + describe(e));
            String fallback = null;
            try {
                if (intent != null) {
                    fallback = intent.getStringExtra("browser_fallback_url");
                }
            } catch (Exception ignored) {
                // Malformed intent extra.
            }
            if (fallback != null && isHttpUrl(fallback) && web != null) {
                web.loadUrl(fallback);
            }
        }
    }

    /** Tells the local page that the remote host page failed; no-ops on the remote page. */
    private void handleMainFrameFailure(int code, String description, String url) {
        if (clientPageActive || isClientUrl(url)) {
            notifyHostError(code, description, url);
            return;
        }
        // The failing document is the remote host page (or its Chromium error page).
        // MDApp is not available there, so remember the error and reload the local
        // client page first; onPageFinished will deliver it to the pool view.
        pendingHostErrorCode = code;
        pendingHostErrorDescription = description;
        pendingHostErrorUrl = url;
        returnToClient();
    }

    private void notifyHostError(int code, String description, String url) {
        WebView view = web;
        if (view == null) {
            return;
        }
        try {
            JSONObject payload = new JSONObject();
            payload.put("code", code);
            payload.put("description", description == null ? "" : description);
            String host = hostLabel(url);
            payload.put("host", host == null ? "" : host);
            // JSONObject output is valid JS; escape the two JS line separators just in case.
            String json = payload.toString()
                    .replace("\u2028", "\\u2028")
                    .replace("\u2029", "\\u2029");
            view.evaluateJavascript("(function(){try{if(window.MDApp&&MDApp.onHostError){"
                    + "MDApp.onHostError(" + json + ");}}catch(e){}})()", null);
        } catch (Exception e) {
            Log.w(TAG, "notifyHostError failed: " + describe(e));
        }
    }

    private void evaluate(String script) {
        WebView view = web;
        if (view == null || script == null || script.isEmpty()) {
            return;
        }
        view.evaluateJavascript(script, null);
    }

    private String directoryUrl() {
        String url = prefs.getString("directoryUrl", DEFAULT_DIRECTORY);
        return hasText(url) ? url.trim() : DEFAULT_DIRECTORY;
    }

    private boolean isClientUrl(String url) {
        if (clientOrigin == null) {
            return false;
        }
        String origin = originOf(url);
        return origin != null && clientOrigin.equals(origin);
    }

    private static String originOf(String url) {
        if (url == null) {
            return null;
        }
        try {
            Uri uri = Uri.parse(url);
            String scheme = lower(uri.getScheme());
            String host = uri.getHost();
            if (host == null || host.isEmpty()) {
                return null;
            }
            if (!"http".equals(scheme) && !"https".equals(scheme)) {
                return null;
            }
            int port = uri.getPort();
            return scheme + "://" + host + (port > 0 ? ":" + port : "");
        } catch (Exception e) {
            return null;
        }
    }

    /** scheme://host:port, never path/query/fragment (pair URLs carry nonces). */
    private static String safeLabel(String url) {
        String origin = originOf(url);
        if (origin != null) {
            return origin;
        }
        if (url == null) {
            return "(null)";
        }
        int cut = url.indexOf('?');
        if (cut >= 0) {
            url = url.substring(0, cut);
        }
        cut = url.indexOf('#');
        if (cut >= 0) {
            url = url.substring(0, cut);
        }
        return url.length() > 80 ? url.substring(0, 80) + "..." : url;
    }

    private static String hostLabel(String url) {
        if (url == null) {
            return null;
        }
        try {
            Uri uri = Uri.parse(url);
            String host = uri.getHost();
            if (host == null || host.isEmpty()) {
                return null;
            }
            int port = uri.getPort();
            return port > 0 ? host + ":" + port : host;
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isHttpUrl(String url) {
        if (url == null) {
            return false;
        }
        try {
            Uri uri = Uri.parse(url.trim());
            String scheme = lower(uri.getScheme());
            String host = uri.getHost();
            return host != null && !host.isEmpty()
                    && ("http".equals(scheme) || "https".equals(scheme));
        } catch (Exception e) {
            return false;
        }
    }

    private static String lower(String value) {
        return value == null ? "" : value.toLowerCase(Locale.US);
    }

    private static boolean hasText(String value) {
        return value != null && !value.trim().isEmpty();
    }

    private static String describe(Throwable t) {
        return t == null ? "unknown" : (t.getClass().getSimpleName() + ": " + t.getMessage());
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                getResources().getDisplayMetrics()));
    }

    // ------------------------------------------------------------------
    // Debug hooks (debuggable builds only)
    // ------------------------------------------------------------------

    private boolean isDebuggable() {
        try {
            return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * `--es js "<js>"` or, shell-quoting proof, `--es js_b64 <base64-js>`.
     * Returns null (and does nothing) in non-debuggable builds.
     */
    private String injectedJs(Intent intent) {
        if (!isDebuggable() || intent == null) {
            return null;
        }
        String base64 = intent.getStringExtra("js_b64");
        if (base64 != null && !base64.isEmpty()) {
            try {
                return new String(Base64.decode(base64, Base64.NO_WRAP), StandardCharsets.UTF_8);
            } catch (Exception e) {
                Log.e(TAG, "bad js_b64 payload: " + describe(e));
            }
        }
        return intent.getStringExtra("js");
    }

    private static String newBridgeToken() {
        byte[] raw = new byte[32];
        new SecureRandom().nextBytes(raw);
        return Base64.encodeToString(raw,
                Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    // ------------------------------------------------------------------
    // JS bridge
    //
    // Every method takes the per-load bridge token as its first argument. A
    // remote host page never receives the client HTML, so it can never learn
    // the token and every call it makes is rejected (constant-time compare).
    // ------------------------------------------------------------------

    private boolean checkToken(String method, String token) {
        String expected = bridgeToken;
        if (expected == null || token == null) {
            Log.w(TAG, "bridge: rejected " + method + " (missing token)");
            return false;
        }
        boolean ok = MessageDigest.isEqual(
                token.getBytes(StandardCharsets.UTF_8),
                expected.getBytes(StandardCharsets.UTF_8));
        if (!ok) {
            Log.w(TAG, "bridge: rejected " + method + " (bad token)");
        }
        return ok;
    }

    private static String normalizeMode(String mode) {
        if (mode == null) {
            return MODE_HOME;
        }
        String normalized = lower(mode.trim());
        if (MODE_HOME.equals(normalized) || MODE_POOL.equals(normalized)
                || MODE_SETTINGS.equals(normalized) || MODE_HOST.equals(normalized)) {
            return normalized;
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Device token storage (Android Keystore AES/GCM)
    // ------------------------------------------------------------------

    private static final String SECURE_TOKEN_PREF = "deviceTokenCipher";
    private static final String SECURE_TOKEN_ALIAS = "multidsh-device-token";
    private static final String AES_GCM = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int GCM_IV_BYTES = 12;

    private SecretKey getOrCreateTokenKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(SECURE_TOKEN_ALIAS)) {
            java.security.Key key = keyStore.getKey(SECURE_TOKEN_ALIAS, null);
            if (key instanceof SecretKey) return (SecretKey) key;
        }
        KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                SECURE_TOKEN_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    private String loadSecureToken() {
        String encoded = prefs.getString(SECURE_TOKEN_PREF, "");
        if (encoded == null || encoded.isEmpty()) return "";
        try {
            byte[] raw = Base64.decode(encoded, Base64.NO_WRAP);
            if (raw.length <= GCM_IV_BYTES) return "";
            Cipher cipher = Cipher.getInstance(AES_GCM);
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateTokenKey(),
                    new GCMParameterSpec(GCM_TAG_BITS, raw, 0, GCM_IV_BYTES));
            byte[] plain = cipher.doFinal(raw, GCM_IV_BYTES, raw.length - GCM_IV_BYTES);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.w(TAG, "loadSecureToken failed: " + describe(e));
            return "";
        }
    }

    private void saveSecureToken(String token) {
        if (token == null || token.isEmpty()) {
            clearSecureToken();
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance(AES_GCM);
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateTokenKey());
            byte[] iv = cipher.getIV();
            byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
            byte[] combined = new byte[iv.length + encrypted.length];
            System.arraycopy(iv, 0, combined, 0, iv.length);
            System.arraycopy(encrypted, 0, combined, iv.length, encrypted.length);
            prefs.edit().putString(SECURE_TOKEN_PREF,
                    Base64.encodeToString(combined, Base64.NO_WRAP)).apply();
        } catch (Exception e) {
            Log.w(TAG, "saveSecureToken failed: " + describe(e));
        }
    }

    private void clearSecureToken() {
        prefs.edit().remove(SECURE_TOKEN_PREF).apply();
    }

    private class Bridge {

        @JavascriptInterface
        public String loadToken(String token) {
            if (!checkToken("loadToken", token)) return "";
            return loadSecureToken();
        }

        @JavascriptInterface
        public void saveToken(String token, String value) {
            if (!checkToken("saveToken", token)) return;
            saveSecureToken(value == null ? "" : value.trim());
        }

        @JavascriptInterface
        public void clearToken(String token) {
            if (!checkToken("clearToken", token)) return;
            clearSecureToken();
        }

        @JavascriptInterface
        public String getDirectory(String token) {
            if (!checkToken("getDirectory", token)) {
                return "";
            }
            return directoryUrl();
        }

        @JavascriptInterface
        public void setDirectory(String token, String url) {
            if (!checkToken("setDirectory", token)) {
                return;
            }
            if (!isHttpUrl(url)) {
                Log.w(TAG, "setDirectory: rejected non-http url");
                return;
            }
            String clean = url.trim();
            while (clean.endsWith("/")) {
                clean = clean.substring(0, clean.length() - 1);
            }
            if (clean.isEmpty()) {
                return;
            }
            final String saved = clean;
            prefs.edit().putString("directoryUrl", saved).apply();
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    loadClient(saved);
                }
            });
            Log.i(TAG, "directory changed to " + safeLabel(saved));
        }

        @JavascriptInterface
        public String getDeviceName(String token) {
            if (!checkToken("getDeviceName", token)) {
                return "";
            }
            String model = Build.MODEL == null ? "device" : Build.MODEL;
            return "android-" + model;
        }

        @JavascriptInterface
        public String getVersion(String token) {
            if (!checkToken("getVersion", token)) {
                return "";
            }
            return APP_VERSION;
        }

        @JavascriptInterface
        public void copy(String token, final String text) {
            if (!checkToken("copy", token)) {
                return;
            }
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        ClipboardManager manager =
                                (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        if (manager != null) {
                            manager.setPrimaryClip(
                                    ClipData.newPlainText("MultiDSH", text == null ? "" : text));
                        }
                    } catch (Exception e) {
                        Log.e(TAG, "copy failed: " + describe(e));
                    }
                }
            });
        }

        @JavascriptInterface
        public void log(String token, String message) {
            if (!checkToken("log", token)) {
                return;
            }
            Log.i(TAG, "page: " + (message == null ? "" : message));
        }

        @JavascriptInterface
        public String http(String token, String method, String url, String headersJson,
                           String body) {
            if (!checkToken("http", token)) {
                return "{\"error\":\"forbidden\"}";
            }
            if (!isHttpUrl(url)) {
                Log.w(TAG, "bridge http: rejected non-http url");
                return "{\"error\":\"invalid url\"}";
            }
            JSONObject result = new JSONObject();
            HttpURLConnection connection = null;
            try {
                String verb = method == null || method.trim().isEmpty()
                        ? "GET" : method.trim().toUpperCase(Locale.US);
                connection = (HttpURLConnection) new URL(url.trim()).openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(20000);
                connection.setRequestMethod(verb);
                connection.setInstanceFollowRedirects(true);
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject headers = new JSONObject(headersJson);
                    for (Iterator<String> keys = headers.keys(); keys.hasNext(); ) {
                        String key = keys.next();
                        connection.setRequestProperty(key, headers.getString(key));
                    }
                }
                if (body != null && !body.isEmpty()
                        && !"GET".equals(verb) && !"HEAD".equals(verb)) {
                    connection.setDoOutput(true);
                    byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                    connection.setFixedLengthStreamingMode(payload.length);
                    OutputStream out = connection.getOutputStream();
                    out.write(payload);
                    out.close();
                }
                int status = connection.getResponseCode();
                InputStream in = status >= 400
                        ? connection.getErrorStream() : connection.getInputStream();
                String text = "";
                if (in != null) {
                    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                    byte[] chunk = new byte[8192];
                    int read;
                    int total = 0;
                    while ((read = in.read(chunk)) > 0) {
                        total += read;
                        if (total > MAX_HTTP_BODY) {
                            Log.w(TAG, "bridge http: response truncated");
                            break;
                        }
                        buffer.write(chunk, 0, read);
                    }
                    in.close();
                    text = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
                }
                result.put("status", status);
                result.put("body", text);
            } catch (Exception e) {
                Log.e(TAG, "bridge http failed: " + describe(e));
                try {
                    result.put("error", describe(e));
                } catch (Exception ignored) {
                    // JSONObject only fails on non-finite numbers; nothing to do here.
                }
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
            return result.toString();
        }

        @JavascriptInterface
        public void openHost(String token, String url) {
            if (!checkToken("openHost", token)) {
                return;
            }
            if (!isHttpUrl(url)) {
                Log.w(TAG, "openHost: rejected non-http url");
                return;
            }
            final String target = url.trim();
            final String host = hostLabel(target);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (web == null) {
                        return;
                    }
                    // The page calls setUiMode("host", machineName) right before openHost; keep
                    // that nicer title and only fall back to the URL host if it did not.
                    if (MODE_HOST.equals(uiMode)) {
                        if (!hasText(currentHostLabel)) {
                            currentHostLabel = host;
                        }
                    } else {
                        currentHostLabel = host;
                        applyUiMode(MODE_HOST, host);
                    }
                    Log.i(TAG, "open host: " + safeLabel(target));
                    // Same WebView: dsh-auth-* cookies from the pair 303 stay in the jar.
                    web.loadUrl(target);
                }
            });
        }

        @JavascriptInterface
        public void setUiMode(String token, String mode, String title) {
            if (!checkToken("setUiMode", token)) {
                return;
            }
            final String normalized = normalizeMode(mode);
            if (normalized == null) {
                Log.w(TAG, "setUiMode: unknown mode");
                return;
            }
            String trimmed = title == null ? null : title.trim();
            if (trimmed != null && trimmed.length() > 80) {
                trimmed = trimmed.substring(0, 80);
            }
            final String finalTitle = trimmed;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applyUiMode(normalized, finalTitle);
                }
            });
        }

        @JavascriptInterface
        public void setTheme(String token, final String theme) {
            if (!checkToken("setTheme", token)) {
                return;
            }
            final boolean dark = "dark".equals(theme);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applyTopBarTheme(dark ? "dark" : "light");
                }
            });
        }

        @JavascriptInterface
        public void closeHost(String token) {
            if (!checkToken("closeHost", token)) {
                return;
            }
            if (!MODE_HOST.equals(uiMode)) {
                return;
            }
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    returnToClient();
                }
            });
        }
    }
}
