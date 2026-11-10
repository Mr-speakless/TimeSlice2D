import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

// No StrictMode on purpose: the scene samples the whole video on mount and must not run twice.
createRoot(document.getElementById('root')!).render(<App />);
