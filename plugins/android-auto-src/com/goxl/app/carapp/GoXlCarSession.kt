package com.goxl.app.carapp

import android.content.Intent
import androidx.car.app.Screen
import androidx.car.app.Session

/**
 * Sessão única do Android Auto para este app. Por enquanto sempre abre
 * MainCarScreen (placeholder "aguardando corrida"/status) — a ponte real de
 * dados com a corrida ativa do motorista (useDriverRide/DriverRideContext)
 * ainda não está implementada (ver tarefa separada de "ponte de dados").
 */
class GoXlCarSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen {
        return MainCarScreen(carContext)
    }
}
