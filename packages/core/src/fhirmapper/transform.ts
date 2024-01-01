import {
  StructureMap,
  StructureMapGroup,
  StructureMapGroupInput,
  StructureMapGroupRule,
  StructureMapGroupRuleDependent,
  StructureMapGroupRuleSource,
  StructureMapGroupRuleTarget,
  StructureMapGroupRuleTargetParameter,
} from '@medplum/fhirtypes';
import { generateId } from '../crypto';
import { evalFhirPathTyped } from '../fhirpath/parse';
import { getTypedPropertyValue, toJsBoolean, toTypedValue } from '../fhirpath/utils';
import { TypedValue } from '../types';
import { tryGetDataType } from '../typeschema/types';

interface TransformContext {
  loader?: (url: string) => StructureMap[];
  parent?: TransformContext;
  variables?: Record<string, TypedValue>;
}

/**
 * Transforms input values using a FHIR StructureMap.
 *
 * See: https://www.hl7.org/fhir/mapping-language.html
 *
 * @param structureMap - The StructureMap to transform.
 * @param input - The input values.
 * @param loader - Optional loader function for loading imported StructureMaps.
 * @returns The transformed values.
 */
export function structureMapTransform(
  structureMap: StructureMap,
  input: TypedValue[],
  loader?: (url: string) => StructureMap[]
): TypedValue[] {
  return evalStructureMap({ loader }, structureMap, input);
}

function evalStructureMap(ctx: TransformContext, structureMap: StructureMap, input: TypedValue[]): TypedValue[] {
  evalImports(ctx, structureMap);
  hoistGroups(ctx, structureMap);
  return evalGroup(ctx, (structureMap.group as StructureMapGroup[])[0], input);
}

function evalImports(ctx: TransformContext, structureMap: StructureMap): void {
  if (ctx.loader && structureMap.import) {
    for (const url of structureMap.import) {
      const importedMaps = ctx.loader(url as string);
      for (const importedMap of importedMaps) {
        hoistGroups(ctx, importedMap);
      }
    }
  }
}

function hoistGroups(ctx: TransformContext, structureMap: StructureMap): void {
  if (structureMap.group) {
    for (const group of structureMap.group) {
      setVariable(ctx, group.name as string, { type: 'StructureMapGroup', value: group });
    }
  }
}

function evalGroup(ctx: TransformContext, group: StructureMapGroup, input: TypedValue[]): TypedValue[] {
  const sourceDefinitions: StructureMapGroupInput[] = [];
  const targetDefinitions: StructureMapGroupInput[] = [];

  for (const inputDefinition of group.input as StructureMapGroupInput[]) {
    if (inputDefinition.mode === 'source') {
      sourceDefinitions.push(inputDefinition);
    }
    if (inputDefinition.mode === 'target') {
      targetDefinitions.push(inputDefinition);
    }
  }

  if (sourceDefinitions.length === 0) {
    throw new Error('Missing source definitions');
  }

  if (targetDefinitions.length === 0) {
    throw new Error('Missing target definitions');
  }

  if (input.length < sourceDefinitions.length) {
    throw new Error(`Not enough arguments (got ${input.length}, min ${sourceDefinitions.length})`);
  }

  if (input.length > sourceDefinitions.length + targetDefinitions.length) {
    throw new Error(
      `Too many arguments (got ${input.length}, max ${sourceDefinitions.length + targetDefinitions.length})`
    );
  }

  const variables: Record<string, TypedValue> = {};
  const outputs = [];
  let inputIndex = 0;

  for (const sourceDefinition of sourceDefinitions) {
    safeAssign(variables, sourceDefinition.name as string, input[inputIndex++]);
  }

  for (const targetDefinition of targetDefinitions) {
    const output = input[inputIndex++] ?? toTypedValue({});
    safeAssign(variables, targetDefinition.name as string, output);
    outputs.push(output);
  }

  const newContext: TransformContext = { parent: ctx, variables };

  if (group.rule) {
    for (const rule of group.rule) {
      evalRule(newContext, rule);
    }
  }

  return outputs;
}

function evalRule(ctx: TransformContext, rule: StructureMapGroupRule): void {
  let haveSource = false;
  if (rule.source) {
    for (const source of rule.source) {
      if (evalSource(ctx, source)) {
        haveSource = true;
      }
    }
  }

  if (!haveSource) {
    return;
  }

  if (rule.target) {
    for (const target of rule.target) {
      evalTarget(ctx, target);
    }
  }
  if (rule.rule) {
    for (const childRule of rule.rule) {
      evalRule(ctx, childRule);
    }
  }
  if (rule.dependent) {
    for (const dependent of rule.dependent) {
      evalDependent(ctx, dependent);
    }
  }
}

function evalSource(ctx: TransformContext, source: StructureMapGroupRuleSource): boolean {
  const sourceContext = getVariable(ctx, source.context as string);
  if (!sourceContext) {
    return false;
  }

  const sourceElement = source.element;
  if (!sourceElement) {
    return true;
  }

  const sourceValue = evalFhirPathTyped(sourceElement, [sourceContext]);
  if (!sourceValue || sourceValue.length === 0) {
    return false;
  }

  if (source.condition) {
    if (!evalCondition(sourceContext, { [source.variable as string]: sourceValue[0] }, source.condition)) {
      return false;
    }
  }

  if (source.check) {
    if (!evalCondition(sourceContext, { [source.variable as string]: sourceValue[0] }, source.check)) {
      throw new Error('Check failed: ' + source.check);
    }
  }

  if (source.variable) {
    setVariable(ctx, source.variable, sourceValue[0]);
  }

  return true;
}

function evalCondition(input: TypedValue, variables: Record<string, TypedValue>, condition: string): boolean {
  return toJsBoolean(evalFhirPathTyped(condition, [input], variables));
}

function evalTarget(ctx: TransformContext, target: StructureMapGroupRuleTarget): void {
  const targetContext = getVariable(ctx, target.context as string);
  if (!targetContext) {
    throw new Error('Target not found: ' + target.context);
  }

  let originalValue = targetContext.value[target.element as string];
  let targetValue: TypedValue;

  // Determine if the target property is an array field or not
  // If the target property is an array, then we need to append to the array
  const isArray = isArrayProperty(targetContext, target.element as string) || Array.isArray(originalValue);

  if (!target.transform) {
    if (isArray || originalValue === undefined) {
      targetValue = toTypedValue({});
    } else {
      targetValue = toTypedValue(originalValue);
    }
  } else {
    switch (target.transform) {
      case 'append':
        targetValue = evalAppend(ctx, target);
        break;
      case 'copy':
        targetValue = evalCopy(ctx, target);
        break;
      case 'create':
        targetValue = evalCreate(ctx, target);
        break;
      case 'evaluate':
        targetValue = evalEvaluate(ctx, target);
        break;
      case 'translate':
        // TODO: Implement
        targetValue = evalCopy(ctx, target);
        break;
      case 'truncate':
        targetValue = evalTruncate(ctx, target);
        break;
      case 'uuid':
        targetValue = { type: 'string', value: generateId() };
        break;
      default:
        throw new Error(`Unsupported transform: ${target.transform}`);
    }
  }

  if (isArray) {
    if (!originalValue) {
      originalValue = [];
      safeAssign(targetContext.value, target.element as string, originalValue);
    }
    originalValue.push(targetValue.value);
  } else {
    safeAssign(targetContext.value, target.element as string, targetValue.value);
  }

  if (target.variable) {
    setVariable(ctx, target.variable, targetValue);
  }
}

function isArrayProperty(targetContext: TypedValue, element: string): boolean | undefined {
  const targetContextTypeDefinition = tryGetDataType(targetContext.type);
  const targetPropertyTypeDefinition = targetContextTypeDefinition?.elements?.[element];
  return targetPropertyTypeDefinition?.isArray;
}

function evalAppend(ctx: TransformContext, target: StructureMapGroupRuleTarget): TypedValue {
  const arg1 = resolveParameter(ctx, target.parameter?.[0])?.value;
  const arg2 = resolveParameter(ctx, target.parameter?.[1])?.value;
  return { type: 'string', value: (arg1 ?? '').toString() + (arg2 ?? '').toString() };
}

function evalCopy(ctx: TransformContext, target: StructureMapGroupRuleTarget): TypedValue {
  return resolveParameter(ctx, target.parameter?.[0]);
}

function evalCreate(ctx: TransformContext, target: StructureMapGroupRuleTarget): TypedValue {
  const result: Record<string, unknown> = {};
  if (target.parameter && target.parameter.length > 0) {
    result.resourceType = resolveParameter(ctx, target.parameter?.[0])?.value;
  }
  return toTypedValue(result);
}

function evalEvaluate(ctx: TransformContext, target: StructureMapGroupRuleTarget): TypedValue {
  const typedExpr = resolveParameter(ctx, target.parameter?.[0]);
  const expr = typedExpr.value as string;
  const allVariables = getAllVariables(ctx);
  const result = evalFhirPathTyped(expr, [], allVariables);
  if (!result || result.length === 0) {
    return toTypedValue(undefined);
  }
  return result[0];
}

function evalTruncate(ctx: TransformContext, target: StructureMapGroupRuleTarget): TypedValue {
  const targetValue = resolveParameter(ctx, target.parameter?.[0]);
  const targetLength = resolveParameter(ctx, target.parameter?.[1])?.value as number;
  if (targetValue.type === 'string') {
    return { type: 'string', value: targetValue.value.substring(0, targetLength) };
  }
  return targetValue;
}

function evalDependent(ctx: TransformContext, dependent: StructureMapGroupRuleDependent): void {
  const dependentGroup = getVariable(ctx, dependent.name as string);
  if (!dependentGroup) {
    throw new Error('Dependent group not found: ' + dependent.name);
  }

  const variables = dependent.variable as string[];
  const args: TypedValue[] = [];
  for (const variable of variables) {
    const variableValue = getVariable(ctx, variable);
    if (!variableValue) {
      throw new Error('Dependent variable not found: ' + variable);
    }
    args.push(variableValue);
  }

  const newContext: TransformContext = { parent: ctx, variables: {} };
  evalGroup(newContext, dependentGroup.value as StructureMapGroup, args);
}

function resolveParameter(
  ctx: TransformContext,
  parameter: StructureMapGroupRuleTargetParameter | undefined
): TypedValue {
  const typedParameter = { type: 'StructureMapGroupRuleTargetParameter', value: parameter };
  let paramValue = getTypedPropertyValue(typedParameter, 'value');

  if (Array.isArray(paramValue)) {
    paramValue = paramValue[0];
  }

  if (!paramValue) {
    throw new Error('Missing target parameter: ' + JSON.stringify(parameter));
  }

  if (paramValue.type === 'id') {
    const variableValue = getVariable(ctx, paramValue.value as string);
    if (!variableValue) {
      throw new Error('Variable not found: ' + paramValue.value);
    }
    return variableValue;
  }

  return paramValue;
}

function getVariable(ctx: TransformContext, name: string): TypedValue | undefined {
  const value = ctx.variables?.[name];
  if (value) {
    return value;
  }
  if (ctx.parent) {
    return getVariable(ctx.parent, name);
  }
  return undefined;
}

function getAllVariables(ctx: TransformContext): Record<string, TypedValue> {
  if (ctx.parent) {
    return { ...getAllVariables(ctx.parent), ...ctx.variables };
  }
  return ctx.variables ?? {};
}

function setVariable(ctx: TransformContext, name: string, value: TypedValue): void {
  if (!ctx.variables) {
    ctx.variables = {};
  }
  safeAssign(ctx.variables, name, value);
}

function safeAssign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    throw new Error('Invalid key: ' + key);
  }
  target[key] = value;
}