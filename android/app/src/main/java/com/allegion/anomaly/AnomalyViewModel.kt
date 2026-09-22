package com.allegion.anomaly

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class UiState(
    val alerts: List<Anomaly> = emptyList(),
    val doorNames: Map<String, String> = emptyMap(),
    val revoked: Set<String> = emptySet()
) {
    /** Raw id is ugly but truthful. A blank looks like a bug. */
    fun doorName(id: String): String = doorNames[id] ?: id
}

class AnomalyViewModel(
    private val repo: AnomalyRepository = AnomalyRepository()
) : ViewModel() {

    /**
     * Door names are a flow starting at empty, NOT a suspending prerequisite.
     * A cold start from a notification tap would otherwise show a spinner over
     * a live alert. Cards render with raw ids and recompose to names a moment
     * later.
     */
    private val doorNames = MutableStateFlow<Map<String, String>>(emptyMap())

    /** Anomaly id from a notification tap. Scrolls to and highlights that card. */
    private val _highlightId = MutableStateFlow<String?>(null)
    val highlightId: StateFlow<String?> = _highlightId.asStateFlow()

    val state: StateFlow<UiState> =
        combine(repo.anomalies(), doorNames, repo.revokedIds()) { alerts, doors, revoked ->
            UiState(alerts = alerts, doorNames = doors, revoked = revoked)
        }.stateIn(
            scope = viewModelScope,
            // Keeps listeners alive briefly across a rotation, drops them when
            // the app is genuinely backgrounded.
            started = SharingStarted.WhileSubscribed(5_000),
            initialValue = UiState()
        )

    init {
        viewModelScope.launch { doorNames.value = repo.doorNames() }
    }

    fun onRevoke(credentialId: String) {
        viewModelScope.launch {
            try {
                repo.revoke(credentialId)
            } catch (e: Exception) {
                // The button simply will not flip. Rules rejection lands here.
                Log.e("AnomalyVM", "revoke $credentialId failed", e)
            }
        }
    }

    fun onHighlight(anomalyId: String?) {
        _highlightId.value = anomalyId
    }
}
