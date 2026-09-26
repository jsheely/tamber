import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Providers } from '../../components/Providers';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
