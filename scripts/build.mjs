import {mkdir,copyFile,cp} from 'node:fs/promises';
await mkdir('dist',{recursive:true});for(const file of ['index.html','style.css','LICENSE'])await copyFile(file,`dist/${file}`);await cp('src','dist/src',{recursive:true});await cp('examples','dist/examples',{recursive:true});console.log('Static build complete: dist/');
