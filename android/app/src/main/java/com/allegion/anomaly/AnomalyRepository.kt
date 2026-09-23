package com.allegion.anomaly

import android.util.Log
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await

private const val TAG = "AnomalyRepo"
private const val FEED_LIMIT = 50L

/**
 * The only place that touches Firestore. The app never learns the backend's
 * address - it reads and writes Firebase, and the backend does the same from
 * the other side. That is the whole reason there is no WebSocket here.
 */
class AnomalyRepository(
    private val db: FirebaseFirestore = FirebaseFirestore.getInstance()
) {

    /**
     * Live red alert feed, newest first.
     *
     * orderBy("created_at") SILENTLY DROPS documents missing that field. The
     * backend always sets it, but a hand-made test doc in the console will not
     * appear. Check that first if a doc exists in Firestore but not on screen.
     */
    fun anomalies(): Flow<List<Anomaly>> = callbackFlow {
        val reg = db.collection("anomalies")
            .orderBy("created_at", Query.Direction.DESCENDING)
            .limit(FEED_LIMIT)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    Log.e(TAG, "anomaly listener failed", err)
                    return@addSnapshotListener
                }
                trySend(snap?.documents?.mapNotNull { it.toAnomaly() } ?: emptyList())
            }
        awaitClose { reg.remove() }
    }

    /**
     * Live amber feed, newest first. Read-only by rule and by intent - there is
     * no write counterpart here, and the security rules block one anyway.
     */
    fun reviews(): Flow<List<Review>> = callbackFlow {
        val reg = db.collection("reviews")
            .orderBy("created_at", Query.Direction.DESCENDING)
            .limit(FEED_LIMIT)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    Log.e(TAG, "review listener failed", err)
                    return@addSnapshotListener
                }
                trySend(snap?.documents?.mapNotNull { it.toReview() } ?: emptyList())
            }
        awaitClose { reg.remove() }
    }

    /**
     * Which credentials are already dead. Server truth, not optimistic local
     * state - watching this is what makes the button flip to REVOKED only once
     * the write has actually landed.
     */
    fun revokedIds(): Flow<Set<String>> = callbackFlow {
        val reg = db.collection("credentials")
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    Log.e(TAG, "credential listener failed", err)
                    return@addSnapshotListener
                }
                val dead = snap?.documents
                    ?.filter { it.getBoolean("revoked") == true }
                    ?.map { it.id }
                    ?.toSet() ?: emptySet()
                trySend(dead)
            }
        awaitClose { reg.remove() }
    }

    /**
     * door_id -> name, fetched once. Ten static documents; a listener would be
     * equally cheap but buys nothing for data that only changes on re-seed.
     * Returns empty on failure - the UI falls back to raw ids, never blanks.
     */
    suspend fun doorNames(): Map<String, String> = try {
        db.collection("doors").get().await()
            .documents.associate { it.id to (it.getString("name") ?: it.id) }
    } catch (e: Exception) {
        Log.e(TAG, "door fetch failed, falling back to raw ids", e)
        emptyMap()
    }

    /**
     * One-tap revoke. This single field write is the whole command path: the
     * backend's onSnapshot watcher rebuilds its registry and the next scan of
     * this credential returns DENY.
     *
     * merge() is required - a plain set() would wipe person_id and the rest.
     * The security rules allow exactly this one key, set to exactly true.
     */
    suspend fun revoke(credentialId: String) {
        db.collection("credentials")
            .document(credentialId)
            .set(mapOf("revoked" to true), SetOptions.merge())
            .await()
    }
}
