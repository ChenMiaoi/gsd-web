import { createRoot } from 'react-dom/client';

import App from './App.js';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Missing #root mount node for gsd-web dashboard');
}

createRoot(rootElement).render(<App />);
