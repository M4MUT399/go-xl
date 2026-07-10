import { registerRootComponent } from 'expo';

// Efeito colateral: define a TASK de background de revogação (Camada 2) no escopo
// do módulo, ANTES de o SO poder invocá-la ao lançar o app em background. Precisa
// vir antes do import de App para o TaskManager.defineTask já estar registrado.
import './src/lib/backgroundNotifications';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
