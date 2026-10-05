package com.mrndstvndv.pidroid.ui

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.mrndstvndv.pidroid.agent.AgentProcessManager
import com.mrndstvndv.pidroid.service.AgentForegroundService
import kotlinx.coroutines.delay

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun AgentWebViewScreen() {
    val context = LocalContext.current
    val isRunning by AgentProcessManager.isRunning.collectAsState()
    val logs by AgentProcessManager.logs.collectAsState()

    var webViewRef by remember { mutableStateOf<WebView?>(null) }
    var isLoaded by remember { mutableStateOf(false) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var showLogs by remember { mutableStateOf(false) }

    val serverUrl = "http://127.0.0.1:${AgentProcessManager.SERVER_PORT}"

    LaunchedEffect(Unit) {
        AgentForegroundService.start(context)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF121316))
    ) {
        // Native Top Control Bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFF1A1C22))
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
                text = if (isRunning) "Agent Online" else "Starting Agent...",
                color = Color.White,
                fontSize = 13.sp,
                style = MaterialTheme.typography.labelMedium
            )

            Spacer(modifier = Modifier.weight(1f))

            Button(
                onClick = { showLogs = !showLogs },
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E3340)),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                modifier = Modifier.height(32.dp)
            ) {
                Text(if (showLogs) "View Web" else "View Logs", fontSize = 11.sp, color = Color.White)
            }

            Spacer(modifier = Modifier.width(6.dp))

            Button(
                onClick = {
                    AgentForegroundService.start(context)
                    webViewRef?.reload()
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

                            webChromeClient = WebChromeClient()
                            webViewClient = object : WebViewClient() {
                                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                                    super.onPageStarted(view, url, favicon)
                                    loadError = null
                                }

                                override fun onPageFinished(view: WebView?, url: String?) {
                                    super.onPageFinished(view, url)
                                    isLoaded = true
                                    loadError = null
                                }

                                override fun onReceivedError(
                                    view: WebView?,
                                    request: WebResourceRequest?,
                                    error: WebResourceError?
                                ) {
                                    super.onReceivedError(view, request, error)
                                    if (request?.isForMainFrame == true) {
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
                            .background(Color(0xFF121316)),
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
