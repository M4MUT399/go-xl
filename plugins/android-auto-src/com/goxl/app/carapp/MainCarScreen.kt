package com.goxl.app.carapp

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Pane
import androidx.car.app.model.PaneTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/**
 * Tela principal do Android Auto para o motorista Go XL.
 *
 * MVP "status + aceitar/recusar" (decisão do usuário — ver
 * plugins/withAndroidAuto.js): mostra a chamada de corrida pendente com
 * botões Aceitar/Recusar, ou o status da corrida ativa, ou o placeholder
 * "Aguardando corrida...". SEM mapa/navegação turn-by-turn dentro do carro
 * nesta fase — isso fica para uma etapa futura (exigiria desbloquear
 * FOREGROUND_SERVICE_LOCATION, hoje deliberadamente bloqueada).
 *
 * A tela se re-renderiza (`invalidate()`) sempre que CarRideStateStore muda
 * — ou seja, sempre que o app RN empurrar um novo estado via
 * CarRideBridgeModule (ver src/native/carRideBridge.ts +
 * DriverRideContext.tsx).
 */
class MainCarScreen(carContext: CarContext) : Screen(carContext) {

    private val onStateChanged: () -> Unit = { invalidate() }

    init {
        CarRideStateStore.addListener(onStateChanged)
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onDestroy(owner: LifecycleOwner) {
                CarRideStateStore.removeListener(onStateChanged)
            }
        })
    }

    override fun onGetTemplate(): Template {
        val offer = CarRideStateStore.currentOffer
        if (offer != null) return buildOfferTemplate(offer)

        val active = CarRideStateStore.activeRide
        if (active != null) return buildActiveRideTemplate(active)

        return MessageTemplate.Builder("Aguardando corrida...")
            .setTitle("Go XL Motorista")
            .build()
    }

    private fun buildOfferTemplate(offer: CarRideStateStore.RideOffer): Template {
        val pane = Pane.Builder()
            .addRow(Row.Builder().setTitle("Embarque").addText(offer.originAddress).build())
            .addRow(Row.Builder().setTitle("Destino").addText(offer.destinationAddress).build())
            .addRow(Row.Builder().setTitle("Valor estimado").addText(offer.priceLabel).build())
            .addAction(
                Action.Builder()
                    .setTitle("Recusar")
                    .setOnClickListener {
                        CarRideStateStore.dispatchAction(carContext, "reject", offer.id)
                    }
                    .build()
            )
            .addAction(
                Action.Builder()
                    .setTitle("Aceitar")
                    .setOnClickListener {
                        CarRideStateStore.dispatchAction(carContext, "accept", offer.id)
                    }
                    .build()
            )
            .build()

        return PaneTemplate.Builder(pane)
            .setTitle("Nova chamada de corrida")
            .setHeaderAction(Action.APP_ICON)
            .build()
    }

    private fun buildActiveRideTemplate(ride: CarRideStateStore.ActiveRideInfo): Template {
        val statusLabel = when (ride.status) {
            "accepted", "driver_en_route" -> "A caminho do embarque"
            "in_progress" -> "Corrida em andamento"
            else -> ride.status
        }
        val pane = Pane.Builder()
            .addRow(Row.Builder().setTitle("Status").addText(statusLabel).build())
            .addRow(Row.Builder().setTitle("Embarque").addText(ride.originAddress).build())
            .addRow(Row.Builder().setTitle("Destino").addText(ride.destinationAddress).build())
            .build()

        return PaneTemplate.Builder(pane)
            .setTitle("Corrida ativa")
            .setHeaderAction(Action.APP_ICON)
            .build()
    }
}
