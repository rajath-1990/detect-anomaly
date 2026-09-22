package com.allegion.anomaly

import com.google.firebase.firestore.DocumentSnapshot
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** One end of an impossible trip: which door, which credential, when. */
data class Leg(
    val doorId: String,
    val credentialId: String,
    val ts: Long
)

/**
 * A red alert, mirroring anomalies/{id} as written by backend/firestore.js.
 * Door NAMES are not in the document - only ids. They get joined against the
 * doors collection in the UI layer.
 */
data class Anomaly(
    val id: String,
    val kind: String,
    val personId: String,
    val personName: String,
    val from: Leg,
    val to: Leg,
    val observedS: Double,
    val requiredS: Double,
    val severity: Double
) {
    /** CLONED_CREDENTIAL -> "CLONED CREDENTIAL", matching the web console. */
    val kindLabel: String get() = kind.replace('_', ' ')

    /**
     * One button per unique credential. A clone is one credential seen twice,
     * so one button. A steal is two credentials on one person, so two - and
     * revoking only one would leave the attacker holding the other.
     */
    val credentialsToRevoke: List<String>
        get() = listOf(from.credentialId, to.credentialId).distinct()
}

private val clockFmt = SimpleDateFormat("HH:mm:ss", Locale.US)

fun Long.asClock(): String = clockFmt.format(Date(this))

/** Trims a trailing .0 so 27.0x reads as 27x, like the console does. */
fun Double.trim(): String =
    if (this == this.toLong().toDouble()) this.toLong().toString() else this.toString()

private fun Any?.asDouble(): Double = (this as? Number)?.toDouble() ?: 0.0
private fun Any?.asLong(): Long = (this as? Number)?.toLong() ?: 0L
private fun Any?.asStr(): String = this as? String ?: ""

private fun Any?.toLeg(): Leg {
    val m = this as? Map<*, *> ?: return Leg("", "", 0L)
    return Leg(
        doorId = m["door_id"].asStr(),
        credentialId = m["credential_id"].asStr(),
        ts = m["ts"].asLong()
    )
}

/**
 * Hand-rolled instead of toObject<Anomaly>(). Node serialises 27.4 as a double
 * but an integral 27 as an int64, and auto-deserialisation across that boundary
 * throws exactly once - on stage. Reading through Number absorbs both.
 * Returns null for a malformed document rather than killing the whole snapshot.
 */
fun DocumentSnapshot.toAnomaly(): Anomaly? {
    val from = get("from").toLeg()
    val to = get("to").toLeg()
    if (from.doorId.isEmpty() || to.doorId.isEmpty()) return null

    return Anomaly(
        id = id,
        kind = get("kind").asStr().ifEmpty { "ANOMALY" },
        personId = get("person_id").asStr(),
        personName = get("person_name").asStr().ifEmpty { "Unknown person" },
        from = from,
        to = to,
        observedS = get("observed_s").asDouble(),
        requiredS = get("required_s").asDouble(),
        severity = get("severity").asDouble()
    )
}
