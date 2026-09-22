package com.allegion.anomaly

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Must match the meta-data value in AndroidManifest.xml. */
const val CHANNEL_ID = "anomalies"

/** Key the backend puts in the FCM data payload. */
const val EXTRA_ANOMALY_ID = "anomaly_id"

/**
 * HIGH importance is the point. FCM's auto-created default channel is
 * DEFAULT importance, which never shows a heads-up banner no matter what
 * priority the backend sends. Creating a channel is idempotent, so calling
 * this on every launch is safe.
 */
fun ensureNotificationChannel(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
        CHANNEL_ID,
        "Impossible travel alerts",
        NotificationManager.IMPORTANCE_HIGH
    ).apply { description = "A credential appeared at two doors faster than a walk allows." }
    ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
}

/**
 * Only runs while the app is in the FOREGROUND. When backgrounded, the system
 * tray renders the notification payload itself and never calls this class -
 * that is what makes the tap-to-open path free.
 */
class AnomalyMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(msg: RemoteMessage) {
        val n = msg.notification ?: return
        ensureNotificationChannel(this)

        val anomalyId = msg.data[EXTRA_ANOMALY_ID]

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_ANOMALY_ID, anomalyId)
        }
        val pending = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle(n.title)
            .setContentText(n.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(n.body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()

        // Permission is requested in MainActivity; if denied this is a no-op.
        if (NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            NotificationManagerCompat.from(this)
                .notify(anomalyId?.hashCode() ?: 0, notification)
        }
    }
}
