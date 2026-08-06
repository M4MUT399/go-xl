package com.goxl.app.carapp

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

/**
 * Ponte JS -> nativo para o Android Auto (Item "ponte de dados" do backlog).
 *
 * O app RN chama isto (ver src/native/carRideBridge.ts, disparado de dentro
 * de DriverRideContext.tsx) toda vez que a oferta de corrida pendente ou a
 * corrida ativa do motorista muda. A tela do carro (MainCarScreen) só LÊ o
 * estado em CarRideStateStore — nunca fala diretamente com o JS.
 *
 * `updateOffer(null)` / `updateActiveRide(null)` limpam o respectivo estado
 * (ex.: oferta expirou, corrida terminou).
 */
class CarRideBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "CarRideBridge"

    @ReactMethod
    fun updateOffer(map: ReadableMap?) {
        if (map == null) {
            CarRideStateStore.setOffer(null)
            return
        }
        CarRideStateStore.setOffer(
            CarRideStateStore.RideOffer(
                id = map.getString("id") ?: return,
                originAddress = map.getString("originAddress") ?: "",
                destinationAddress = map.getString("destinationAddress") ?: "",
                priceLabel = map.getString("priceLabel") ?: "",
            )
        )
    }

    @ReactMethod
    fun updateActiveRide(map: ReadableMap?) {
        if (map == null) {
            CarRideStateStore.setActiveRide(null)
            return
        }
        CarRideStateStore.setActiveRide(
            CarRideStateStore.ActiveRideInfo(
                id = map.getString("id") ?: return,
                status = map.getString("status") ?: "",
                originAddress = map.getString("originAddress") ?: "",
                destinationAddress = map.getString("destinationAddress") ?: "",
            )
        )
    }

    @ReactMethod
    fun clearAll() {
        CarRideStateStore.clearAll()
    }

    // NativeEventEmitter (JS) exige addListener/removeListeners no módulo
    // nativo mesmo quando os eventos são emitidos de outro lugar (aqui,
    // CarRideStateStore.dispatchAction usa o emitter global do RN
    // diretamente) — sem isto o RN loga um warning "new NativeEventEmitter
    // ... requires a non-null argument", inofensivo mas evitável.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}
