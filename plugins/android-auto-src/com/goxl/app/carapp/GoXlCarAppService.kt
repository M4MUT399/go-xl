package com.goxl.app.carapp

import androidx.car.app.CarAppService
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

/**
 * Ponto de entrada do Android Auto para o Go XL — só o fluxo do MOTORISTA é
 * exposto aqui (ver plano em src/hooks/useRide.ts / DriverRideContext, que é
 * a mesma fonte de estado usada pelo app "normal" em foreground).
 *
 * IMPORTANTE (segurança): `HostValidator.ALLOW_ALL_HOSTS_VALIDATOR` só é
 * aceitável enquanto builds são de DEV/testes internos (DHU / emulador). Antes
 * de qualquer build de PRODUÇÃO ir para a Play Store, isto precisa trocar
 * para uma allowlist real dos hosts do Android Auto/Automotive OS — ver
 * https://developer.android.com/reference/androidx/car/app/validation/HostValidator
 * Deixado como TODO explícito para não esquecer no rollout.
 */
class GoXlCarAppService : CarAppService() {
    override fun createHostValidator(): HostValidator {
        // TODO(produção): substituir por allowlist real antes do release público.
        return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
    }

    override fun onCreateSession(): Session {
        return GoXlCarSession()
    }
}
