import { render } from 'preact';
import '../styles/app.css';
import './styles/cue.css';
import './app/theme';
import { App } from './App';
import { open, savedSession } from './app/state';

render(<App />, document.getElementById('app')!);

// pick up where this device left off (a device link in the URL wins)
if (!/^#\/link\//.test(location.hash)) {
  const s = savedSession();
  if (s) open(s);
}
