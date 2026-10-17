import { createApp } from 'vue';
import App from './components/App.vue';
import { formatSize } from './utils/format.js';

const app = createApp(App);

app.config.globalProperties.$fmt = formatSize;
app.config.errorHandler = (err, instance, info) => {
  console.error('[app]', err, info);
};

app.mount('#root');
