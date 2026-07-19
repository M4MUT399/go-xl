import { registerRootComponent } from 'expo';

// Efeito colateral: define a TASK de background de revogação (Camada 2) no escopo
// do módulo, ANTES de o SO poder invocá-la ao lançar o app em background. Precisa
// vir antes do import de App para o TaskManager.defineTask já estar registrado.
import './src/lib/backgroundNotifications';

// Efeito colateral: define a TASK de localização em background (Nav Fase 5b) no
// escopo do módulo, pelo mesmo motivo acima — precisa estar registrada antes de
// o SO poder relançar o app e invocar a task.
import './src/lib/nav/backgroundLocationTask';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
