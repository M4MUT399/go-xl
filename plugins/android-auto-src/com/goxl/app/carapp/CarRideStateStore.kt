package com.goxl.app.carapp

import android.content.Context
import com.facebook.react.ReactApplication
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.lang.ref.WeakReference

/**
 * Estado da corrida do motorista, compartilhado entre o app React Native
 * (que escreve, via CarRideBridgeModule) e a tela do Android Auto
 * (que só lê/renderiza, em MainCarScreen).
 *
 * Por que um singleton em memória e não outro mecanismo (broadcast,
 * SharedPreferences, etc.): CarAppService roda no mesmo processo do app
 * (mesma APK, não é um processo `:remote` separado), então um objeto
 * `object` do Kotlin já é compartilhado entre o código RN e o código do
 * carro sem I/O — mais simples e mais rápido que persistir em disco algo
 * que só precisa sobreviver enquanto o processo está vivo.
 *
 * MVP (decisão do usuário, ver plugins/withAndroidAuto.js): só
 * status + aceitar/recusar. Nada de navegação turn-by-turn ainda.
 */
object CarRideStateStore {

    data class RideOffer(
        val id: String,
        val originAddress: String,
        val destinationAddress: String,
        val priceLabel: String,
    )

    data class ActiveRideInfo(
        val id: String,
        val status: String,
        val originAddress: String,
        val destinationAddress: String,
    )

    @Volatile
    var currentOffer: RideOffer? = null
        private set

    @Volatile
    var activeRide: ActiveRideInfo? = null
        private set

    // WeakReference para não segurar a Screen viva além do ciclo de vida dela
    // (evita vazamento se o motorista sair da tela do carro sem o listener
    // ser explicitamente removido).
    private val listeners = mutableListOf<WeakReference<() -> Unit>>()

    fun addListener(listener: () -> Unit) {
        listeners.add(WeakReference(listener))
    }

    fun removeListener(listener: () -> Unit) {
        listeners.removeAll { it.get() == null || it.get() === listener }
    }

    private fun notifyListeners() {
        listeners.removeAll { it.get() == null }
        listeners.forEach { it.get()?.invoke() }
    }

    fun setOffer(offer: RideOffer?) {
        currentOffer = offer
        notifyListeners()
    }

    fun setActiveRide(ride: ActiveRideInfo?) {
        activeRide = ride
        notifyListeners()
    }

    fun clearAll() {
        currentOffer = null
        activeRide = null
        notifyListeners()
    }

    /**
     * Encaminha uma ação do carro (aceitar/recusar) de volta para o JS —
     * a DECISÃO de negócio (chamar acceptRide, revogar oferta, etc.)
     * continua toda em GlobalDriverRideOverlay.tsx; o carro só dispara o
     * evento, igual um botão a mais na UI.
     *
     * `rideId` vai junto no payload para o listener em JS conferir que ainda
     * é a MESMA oferta antes de agir (evita agir sobre uma oferta já
     * expirada/trocada entre o toque no carro e o evento chegar no JS).
     */
    fun dispatchAction(context: Context, action: String, rideId: String) {
        val reactContext = (context.applicationContext as? ReactApplication)
            ?.reactNativeHost
            ?.reactInstanceManager
            ?.currentReactContext ?: return

        val params = com.facebook.react.bridge.Arguments.createMap().apply {
            putString("action", action)
            putString("rideId", rideId)
        }

        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("GoXlCarRideAction", params)
    }
}
