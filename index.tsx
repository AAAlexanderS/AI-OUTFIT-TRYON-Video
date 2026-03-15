import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Intercept fetch to add referrerPolicy for Gemini API
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  let url = '';
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else if (input instanceof Request) {
    url = input.url;
  }

  if (url.includes('googleapis.com')) {
    init = { 
      ...init, 
      referrerPolicy: 'origin',
      referrer: window.location.href
    };
  }
  
  return originalFetch(input, init);
};

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);