const worker = new Worker('worker.js');
// worker threads dont have access to the document, so we just receive the blob URI and use it as src
worker.onmessage = msg => document.querySelector('#image').src = msg.data;
