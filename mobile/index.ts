import { registerRootComponent } from 'expo';
import { Buffer } from 'buffer';

// Polyfill Buffer for BLE/base64 utilities
(global as any).Buffer = (global as any).Buffer || Buffer;

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
