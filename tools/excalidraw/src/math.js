// Calculadora das caixas de texto da lousa: math.js com as funções que mexem no próprio
// interpretador bloqueadas (recomendação de segurança do math.js).
import {create, all} from 'mathjs';

const math = create(all);
export const evaluate = math.evaluate;
export const format = math.format;
export const typeOf = math.typeOf;

const blocked = () => { throw new Error('Função indisponível na lousa.'); };
math.import({
  import: blocked, createUnit: blocked, evaluate: blocked, parse: blocked,
  simplify: blocked, derivative: blocked, resolve: blocked, reviver: blocked,
}, {override: true});
