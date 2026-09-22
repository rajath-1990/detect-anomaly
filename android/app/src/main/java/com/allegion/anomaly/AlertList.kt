package com.allegion.anomaly

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Same three semantic colours as the operator console.
private val Deny = Color(0xFFB4302B)
private val Ink = Color(0xFF1A1A1A)
private val Muted = Color(0xFF6B6B6B)
private val Dead = Color(0xFF8A8A8A)

@Composable
fun AlertScreen(
    state: UiState,
    highlightId: String?,
    onRevoke: (String) -> Unit
) {
    if (state.alerts.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No impossible movement detected.", color = Muted, fontSize = 15.sp)
        }
        return
    }

    val listState = rememberLazyListState()

    // Notification tap: scroll to the card that was pushed.
    LaunchedEffect(highlightId, state.alerts) {
        val i = state.alerts.indexOfFirst { it.id == highlightId }
        if (i >= 0) listState.animateScrollToItem(i)
    }

    LazyColumn(
        state = listState,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxSize()
    ) {
        items(state.alerts, key = { it.id }) { a ->
            AlertCard(
                anomaly = a,
                state = state,
                highlighted = a.id == highlightId,
                onRevoke = onRevoke
            )
        }
    }
}

@Composable
private fun AlertCard(
    anomaly: Anomaly,
    state: UiState,
    highlighted: Boolean,
    onRevoke: (String) -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = Color(0xFFFDF4F3)),
        border = if (highlighted) BorderStroke(2.dp, Deny) else null
    ) {
        Column(Modifier.padding(16.dp)) {

            Text(
                anomaly.kindLabel,
                color = Deny,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.2.sp
            )
            Spacer(Modifier.height(6.dp))
            Text(anomaly.personName, color = Ink, fontSize = 19.sp, fontWeight = FontWeight.Bold)
            Text(anomaly.personId, color = Muted, fontSize = 12.sp, fontFamily = FontFamily.Monospace)

            Spacer(Modifier.height(12.dp))
            LegRow("FROM", anomaly.from, state)
            Spacer(Modifier.height(6.dp))
            LegRow("TO", anomaly.to, state)

            Spacer(Modifier.height(12.dp))
            HorizontalDivider(color = Color(0x22B4302B))
            Spacer(Modifier.height(12.dp))

            Text(
                "${anomaly.severity.trim()}x",
                color = Deny,
                fontSize = 34.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace
            )
            Text(
                "faster than possible - crossed in ${anomaly.observedS.trim()}s, " +
                    "minimum ${anomaly.requiredS.trim()}s",
                color = Muted,
                fontSize = 12.sp
            )

            Spacer(Modifier.height(14.dp))
            // One button per unique credential: 1 for a clone, 2 for a steal.
            anomaly.credentialsToRevoke.forEach { credId ->
                RevokeButton(
                    credentialId = credId,
                    isRevoked = credId in state.revoked,
                    onRevoke = onRevoke
                )
                Spacer(Modifier.height(8.dp))
            }
        }
    }
}

@Composable
private fun LegRow(label: String, leg: Leg, state: UiState) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Muted, fontSize = 10.sp, modifier = Modifier.padding(end = 10.dp))
        Column(Modifier.weight(1f)) {
            Text(state.doorName(leg.doorId), color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text(leg.credentialId, color = Muted, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
        }
        Text(leg.ts.asClock(), color = Muted, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
    }
}

@Composable
private fun RevokeButton(credentialId: String, isRevoked: Boolean, onRevoke: (String) -> Unit) {
    Button(
        onClick = { onRevoke(credentialId) },
        enabled = !isRevoked,
        modifier = Modifier.fillMaxWidth(),
        colors = ButtonDefaults.buttonColors(
            containerColor = Deny,
            disabledContainerColor = Color(0xFFE4E4E4),
            disabledContentColor = Dead
        )
    ) {
        Text(if (isRevoked) "REVOKED $credentialId" else "Revoke $credentialId")
    }
}
