package com.allegion.anomaly

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.firebase.messaging.FirebaseMessaging

/** Backend sends to this topic. Must match ALERT_TOPIC in backend/firestore.js. */
private const val ALERT_TOPIC = "anomalies"

class MainActivity : ComponentActivity() {

    // Survives rotation, and is reachable from onNewIntent before setContent runs.
    private val vm: AnomalyViewModel by viewModels()

    private val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            Log.i("MainActivity", "notification permission granted=$granted")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        ensureNotificationChannel(this)
        requestNotificationPermission()
        subscribeToAlerts()

        // Cold start from a notification tap.
        handleIntent(intent)

        setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    val state by vm.state.collectAsStateWithLifecycle()
                    val highlight by vm.highlightId.collectAsStateWithLifecycle()

                    AlertScreen(
                        state = state,
                        highlightId = highlight,
                        onRevoke = vm::onRevoke
                    )
                }
            }
        }
    }

    /**
     * Tap while already running. Needs launchMode="singleTop" in the manifest -
     * without it the tap spawns a second Activity instance instead.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        // FCM data payload keys arrive as plain string extras on the launch intent.
        intent?.extras?.getString(EXTRA_ANOMALY_ID)?.let { vm.onHighlight(it) }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /**
     * A topic, not a device token. One call here replaces a devices collection,
     * token upload and a fan-out loop on the backend. Cost: anyone holding the
     * APK receives alerts.
     */
    private fun subscribeToAlerts() {
        FirebaseMessaging.getInstance().subscribeToTopic(ALERT_TOPIC)
            .addOnCompleteListener { t ->
                Log.i("MainActivity", "subscribe to '$ALERT_TOPIC' ok=${t.isSuccessful}")
            }
    }
}
