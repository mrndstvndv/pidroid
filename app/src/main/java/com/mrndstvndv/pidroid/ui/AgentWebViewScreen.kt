package com.mrndstvndv.pidroid.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.view.ViewGroup
import android.widget.Toast
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.net.toUri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.mrndstvndv.pidroid.agent.AgentMode
import com.mrndstvndv.pidroid.agent.AgentProcessManager
import com.mrndstvndv.pidroid.agent.ConflictChoice
import com.mrndstvndv.pidroid.service.AgentForegroundService
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun AgentWebViewScreen() {
    val context = LocalContext.current
    val isRunning by AgentProcessManager.isRunning.collectAsState()
    val logs by AgentProcessManager.logs.collectAsState()
    val mode by AgentProcessManager.mode.collectAsState()

    var webViewRef by remember { mutableStateOf<WebView?>(null) }
    var isLoaded by remember { mutableStateOf(false) }
    var loadError by remember { mutableStateOf<String?>(null) }
    // True while the current load hit a main-frame error (e.g. the server isn't up yet). WebViewClient still calls
    // onPageFinished for Chrome's error page, so without this the failed page would count as "loaded" and never retry.
    val pageFailed = remember { BooleanArray(1) }
    var showLogs by remember { mutableStateOf(false) }
    var showRecover by remember { mutableStateOf(false) }
    var confirmReset by remember { mutableStateOf(false) }
    val conflicts by AgentProcessManager.conflicts.collectAsState()
    val scope = rememberCoroutineScope()

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

    // Works even when the agent has broken its own web UI: these talk to the server / files natively.
    if (showRecover) {
        AlertDialog(
            onDismissRequest = { showRecover = false },
            containerColor = Color(0xFF0D0D0D),
            title = { Text("Recover", color = Color.White) },
            text = {
                Column {
                    Text(
                        "Undo the agent's latest change, or put the app's own files back to the version shipped with this app. " +
                            "Nothing is lost: both are recorded in the Changes history.",
                        color = Color(0xFF9CA3AF),
                        fontSize = 13.sp
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    TextButton(onClick = {
                        showRecover = false
                        scope.launch {
                            val message = AgentProcessManager.undoLatestChange()
                            Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
                            webViewRef?.reload()
                        }
                    }) { Text("Undo last change", color = Color(0xFF6366F1)) }
                    TextButton(onClick = {
                        showRecover = false
                        confirmReset = true
                    }) { Text("Reset UI to shipped version", color = Color(0xFFF87171)) }
                }
            },
            confirmButton = {
                TextButton(onClick = { showRecover = false }) { Text("Close", color = Color.White) }
            }
        )
    }

    if (confirmReset) {
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            containerColor = Color(0xFF0D0D0D),
            title = { Text("Reset to shipped version?", color = Color.White) },
            text = {
                Text(
                    "Every app file, including the web UI, goes back to what shipped with this app, and files the agent " +
                        "added under www/ are removed. The agent restarts. You can undo this from the Changes history.",
                    color = Color(0xFF9CA3AF),
                    fontSize = 13.sp
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmReset = false
                    isLoaded = false
                    AgentProcessManager.resetToShipped(context)
                }) { Text("Reset", color = Color(0xFFF87171)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmReset = false }) { Text("Cancel", color = Color.White) }
            }
        )
    }

    // An app update changed files the agent had also edited: ask which version wins.
    if (conflicts.isNotEmpty()) {
        AlertDialog(
            onDismissRequest = {},
            containerColor = Color(0xFF0D0D0D),
            title = { Text("Update conflicts with the agent's edits", color = Color.White) },
            text = {
                Column {
                    Text(
                        "This update changes files the agent has modified. Pick which version to use. " +
                            "The other one stays in the Changes history.",
                        color = Color(0xFF9CA3AF),
                        fontSize = 13.sp
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    conflicts.forEach {
                        Text(it, color = Color(0xFFE5E7EB), fontSize = 12.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { AgentProcessManager.resolveConflicts(context, ConflictChoice.KEEP_AGENT) }) {
                    Text("Keep agent's version", color = Color(0xFF6366F1))
                }
            },
            dismissButton = {
                TextButton(onClick = { AgentProcessManager.resolveConflicts(context, ConflictChoice.USE_SHIPPED) }) {
                    Text("Use new app version", color = Color.White)
                }
            }
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF000000))
    ) {
        // Native Top Control Bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFF000000))
                .statusBarsPadding()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .background(
                        if (isRunning) Color(0xFF10B981) else Color(0xFFEF4444),
                        shape = androidx.compose.foundation.shape.CircleShape
                    )
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = when {
                    !isRunning -> "Starting Agent..."
                    mode == AgentMode.SAFE -> "Safe mode"
                    else -> "Agent Online"
                },
                color = Color.White,
                fontSize = 13.sp,
                style = MaterialTheme.typography.labelMedium
            )

            Spacer(modifier = Modifier.weight(1f))

            Button(
                onClick = { showRecover = true },
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1A1A1A)),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                modifier = Modifier.height(32.dp)
            ) {
                Text("Recover", fontSize = 11.sp, color = Color.White)
            }

            Spacer(modifier = Modifier.width(6.dp))

            Button(
                onClick = { showLogs = !showLogs },
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1A1A1A)),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                modifier = Modifier.height(32.dp)
            ) {
                Text(if (showLogs) "View Web" else "View Logs", fontSize = 11.sp, color = Color.White)
            }

            Spacer(modifier = Modifier.width(6.dp))

            Button(
                onClick = {
                    // Real restart: also leaves safe mode and retries the agent-editable server.
                    isLoaded = false
                    AgentProcessManager.restart(context)
                },
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF6366F1)),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                modifier = Modifier.height(32.dp)
            ) {
                Text("Restart", fontSize = 11.sp, color = Color.White)
            }
        }

        if (showLogs) {
            // Live Process Logs Screen
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(12.dp)
            ) {
                item {
                    Text(
                        "Runtime & Process Logs",
                        color = Color(0xFF9CA3AF),
                        fontSize = 13.sp,
                        modifier = Modifier.padding(bottom = 8.dp)
                    )
                }
                items(logs) { log ->
                    Text(
                        text = log,
                        color = if (log.contains("ERROR")) Color(0xFFF87171) else Color(0xFFE5E7EB),
                        fontSize = 12.sp,
                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                        modifier = Modifier.padding(vertical = 2.dp)
                    )
                }
            }
        } else {
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
                            webViewRef = this
                        }
                    },
                    update = { view ->
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
                            .background(Color(0xFF000000)),
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
}
