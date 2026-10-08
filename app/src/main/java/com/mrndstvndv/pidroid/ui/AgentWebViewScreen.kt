package com.mrndstvndv.pidroid.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.view.ViewGroup
import android.widget.Toast
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.net.toUri
import androidx.core.view.WindowCompat
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.mrndstvndv.pidroid.agent.AgentProcessManager
import com.mrndstvndv.pidroid.service.AgentForegroundService
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun AgentWebViewScreen() {
    val context = LocalContext.current
    val isRunning by AgentProcessManager.isRunning.collectAsState()
    // The page is edge to edge, so it needs the status bar height to keep its header clear of it (read by the bridge).
    val density = LocalDensity.current
    // The web UI owns the theme (it can differ from the system's), so it reports its page background through the
    // bridge. The status/nav bar icons are picked for contrast against that colour, and the loading screen uses it.
    // Until it reports, follow the Android theme.
    var reportedBg by remember { mutableStateOf<Color?>(null) }
    val systemDark = isSystemInDarkTheme()
    val isLight = reportedBg?.let { it.luminance() > 0.5f } ?: !systemDark
    val systemDarkHolder = remember { BooleanArray(1) }
    systemDarkHolder[0] = systemDark
    val pageBg = reportedBg ?: if (isLight) Color.White else Color.Black
    val barsView = androidx.compose.ui.platform.LocalView.current
    LaunchedEffect(isLight) {
        var c = context
        while (c is ContextWrapper && c !is Activity) c = c.baseContext
        (c as? Activity)?.window?.let {
            val controller = WindowCompat.getInsetsController(it, barsView)
            controller.isAppearanceLightStatusBars = isLight
            controller.isAppearanceLightNavigationBars = isLight
        }
    }
    val statusBarDp = remember { FloatArray(1) }
    statusBarDp[0] = with(density) { WindowInsets.statusBars.getTop(density).toDp().value }

    var webViewRef by remember { mutableStateOf<WebView?>(null) }
    // Back gesture: the page owns what is open (dialogs, sidebar, file viewer, Settings/Artifacts) and tells us
    // through setCanGoBack, because the handler must be armed before the gesture starts. With nothing open this
    // is disabled, so back leaves the app as usual.
    var pageCanGoBack by remember { mutableStateOf(false) }
    BackHandler(enabled = pageCanGoBack) {
        webViewRef?.evaluateJavascript("window.pidroidBack && pidroidBack()", null)
    }
    LaunchedEffect(systemDark) {
        webViewRef?.evaluateJavascript("window.pidroidSystemThemeChanged && pidroidSystemThemeChanged()", null)
    }
    var isLoaded by remember { mutableStateOf(false) }
    var loadError by remember { mutableStateOf<String?>(null) }
    // True while the current load hit a main-frame error (e.g. the server isn't up yet). WebViewClient still calls
    // onPageFinished for Chrome's error page, so without this the failed page would count as "loaded" and never retry.
    val pageFailed = remember { BooleanArray(1) }

    // <input type="file"> in the web UI (the agent's attach button) does nothing unless the app answers the WebView's
    // file-chooser request. Android hands back content:// URIs the WebView can read itself, so no storage permission
    // is involved. The callback must always be completed (null on cancel) or the next request is ignored.
    var pendingFileChooser by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val fileChooserLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        pendingFileChooser?.onReceiveValue(uris)
        pendingFileChooser = null
    }

    val serverUrl = "http://127.0.0.1:${AgentProcessManager.SERVER_PORT}"

    LaunchedEffect(Unit) {
        AgentForegroundService.start(context)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(pageBg)
    ) {
        // WebView Container
        Box(modifier = Modifier.fillMaxSize()) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    WebView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.allowFileAccess = true
                        settings.allowContentAccess = true

                        webChromeClient = object : WebChromeClient() {
                            override fun onShowFileChooser(
                                webView: WebView?,
                                filePathCallback: ValueCallback<Array<Uri>>?,
                                fileChooserParams: FileChooserParams?
                            ): Boolean {
                                pendingFileChooser?.onReceiveValue(null) // a picker is already open: cancel the old request
                                pendingFileChooser = filePathCallback
                                return try {
                                    fileChooserLauncher.launch(fileChooserParams!!.createIntent())
                                    true
                                } catch (e: Exception) {
                                    pendingFileChooser = null
                                    filePathCallback?.onReceiveValue(null)
                                    Toast.makeText(context, "No file picker available", Toast.LENGTH_SHORT).show()
                                    false
                                }
                            }
                        }
                        webViewClient = object : WebViewClient() {
                            // Provider login links (OAuth, device codes) open in the system browser;
                            // only the local agent server stays inside the WebView.
                            override fun shouldOverrideUrlLoading(
                                view: WebView?,
                                request: WebResourceRequest?
                            ): Boolean {
                                val uri = request?.url ?: return false
                                if (uri.host == "127.0.0.1" || uri.host == "localhost") return false
                                runCatching {
                                    ctx.startActivity(
                                        Intent(Intent.ACTION_VIEW, uri.toString().toUri())
                                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                    )
                                }
                                return true
                            }

                            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                                super.onPageStarted(view, url, favicon)
                                pageFailed[0] = false
                                loadError = null
                            }

                            override fun onPageFinished(view: WebView?, url: String?) {
                                super.onPageFinished(view, url)
                                if (pageFailed[0]) {
                                    // Keep the retry loop running until the server answers.
                                    isLoaded = false
                                } else {
                                    isLoaded = true
                                    loadError = null
                                }
                            }

                            override fun onReceivedError(
                                view: WebView?,
                                request: WebResourceRequest?,
                                error: WebResourceError?
                            ) {
                                super.onReceivedError(view, request, error)
                                if (request?.isForMainFrame == true) {
                                    pageFailed[0] = true
                                    loadError = "Connecting to agent server..."
                                }
                            }
                        }
                        // Bridge for the web UI. The restart goes through here rather than /api/restart because this works
                        // even when the agent-editable server is broken, and it also leaves safe mode.
                        addJavascriptInterface(object {
                            @JavascriptInterface
                            fun statusBarHeight(): Float = statusBarDp[0]

                            // A WebView derives prefers-color-scheme from the app's own (dark) theme, so the page asks
                            // the host for the real Android setting.
                            @JavascriptInterface
                            fun systemIsDark(): Boolean = systemDarkHolder[0]

                            // The page reports its background colour (#rgb / #rrggbb); bar icons and the loading screen follow it.
                            @JavascriptInterface
                            fun setBarColor(css: String) {
                                val parsed = runCatching { android.graphics.Color.parseColor(css.trim()) }.getOrNull() ?: return
                                post { reportedBg = Color(parsed) }
                            }

                            @JavascriptInterface
                            fun setCanGoBack(canGoBack: Boolean) {
                                post { pageCanGoBack = canGoBack }
                            }

                            @JavascriptInterface
                            fun restart() {
                                post {
                                    isLoaded = false
                                    AgentProcessManager.restart(ctx)
                                }
                            }

                            // Same path as the notification's Stop agent button: the service stops the agent and closes the app.
                            @JavascriptInterface
                            fun shutdown() {
                                post { AgentForegroundService.stop(ctx) }
                            }
                        }, "PidroidHost")
                        webViewRef = this
                    }
                },
                update = { view ->
                    // A WebView paints white until its first frame; match the page so there is no flash.
                    view.setBackgroundColor(pageBg.toArgb())
                    if (isRunning && !isLoaded && loadError == null) {
                        view.loadUrl(serverUrl)
                    }
                }
            )

            // Retry / Loading overlay while server boots up
            if (!isLoaded || loadError != null) {
                LaunchedEffect(isRunning, loadError) {
                    while (!isLoaded && isRunning) {
                        delay(1500)
                        webViewRef?.loadUrl(serverUrl)
                    }
                }

                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(pageBg),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(color = Color(0xFF6366F1))
                        Spacer(modifier = Modifier.height(16.dp))
                        Text(
                            text = loadError ?: "Initializing Bun Agent...",
                            color = Color(0xFF9CA3AF),
                            fontSize = 14.sp
                        )
                    }
                }
            }
        }
    }
}
