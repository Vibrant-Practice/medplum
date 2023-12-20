import { Group, NativeSelect } from '@mantine/core';
import { LRUCache, MedplumClient, ReadablePromise, createReference, isEmpty, tryGetProfile } from '@medplum/core';
import { Reference, Resource, ResourceType, StructureDefinition } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react-hooks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ResourceInput } from '../ResourceInput/ResourceInput';
import { ResourceTypeInput } from '../ResourceTypeInput/ResourceTypeInput';

export interface ReferenceInputProps {
  name: string;
  placeholder?: string;
  defaultValue?: Reference;
  targetTypes?: string[];
  searchCriteria?: Record<string, string>;
  autoFocus?: boolean;
  required?: boolean;
  onChange?: (value: Reference | undefined) => void;
}

interface BaseTargetType {
  value: string;
}

type ProfileTargetType = BaseTargetType & {
  type: 'profile';
  name?: string;
  title?: string;
  resourceType?: string;
  error?: any;
};

type ResourceTypeTargetType = BaseTargetType & {
  type: 'resourceType';
  resourceType: string;
};
type TargetType = ResourceTypeTargetType | ProfileTargetType;

export function ReferenceInput(props: ReferenceInputProps): JSX.Element {
  const { onChange } = props;
  const medplum = useMedplum();
  const [value, setValue] = useState<Reference | undefined>(props.defaultValue);
  const [targetTypes, setTargetTypes] = useState<TargetType[] | undefined>(() => createTargetTypes(props.targetTypes));
  const [targetType, setTargetType] = useState<TargetType | undefined>(() =>
    getInitialTargetType(props.defaultValue, targetTypes)
  );

  const promiseCache = useRef(new LRUCache<ReadablePromise<TargetType>>());

  const searchCriteria = useMemo<ReferenceInputProps['searchCriteria']>(() => {
    if (targetType?.type === 'profile') {
      return { ...props.searchCriteria, _profile: targetType.value };
    }
    return props.searchCriteria;
  }, [props.searchCriteria, targetType]);

  useEffect(() => {
    let anyToFetch = false;
    const newTargetTypePromises: Promise<TargetType>[] | undefined = targetTypes?.map((tt) => {
      if (!shouldFetchResourceType(tt)) {
        return Promise.resolve(tt);
      }

      anyToFetch = true;
      const cacheKey = tt.value;
      const cached = promiseCache.current.get(cacheKey);
      if (cached) {
        return cached;
      }

      const promise = fetchResourceTypeOfProfile(medplum, tt.value)
        .then((profile) => {
          const newTargetType = { ...tt };

          if (!profile) {
            console.error(`StructureDefinition for ${tt.value} not found`);
            newTargetType.error = 'StructureDefinition not found';
          } else if (!profile.type || isEmpty(profile.type)) {
            console.error(`resourceType for ${tt.value} StructureDefinition missing`);
            newTargetType.error = 'resourceType unavailable';
          } else {
            newTargetType.resourceType = profile.type satisfies string;
            newTargetType.name = profile.name;
            newTargetType.title = profile.title;
          }

          return newTargetType;
        })
        .catch((reason) => {
          console.error(reason);
          return { ...tt, error: reason };
        });

      const readablePromise = new ReadablePromise(promise);
      promiseCache.current.set(cacheKey, readablePromise);

      return readablePromise;
    });

    if (!newTargetTypePromises || !anyToFetch) {
      return;
    }

    Promise.all(newTargetTypePromises)
      .then((newTargetTypes) => {
        setTargetTypes(newTargetTypes);
        if (targetType) {
          const index = newTargetTypes.findIndex(
            (tt) => tt.value === targetType.value || tt.resourceType === targetType.resourceType
          );
          if (index >= 0) {
            // orphaned targetType has been resolved
            setTargetType(newTargetTypes[index]);
          } else {
            console.debug(`defaultValue had unexpected resourceType: ${targetType.resourceType}`);
          }
        }
      })
      .catch(console.error);
  }, [medplum, targetType, targetTypes]);

  const setValueHelper = useCallback(
    (item: Resource | undefined) => {
      const newValue = item ? createReference(item) : undefined;
      setValue(newValue);
      if (onChange) {
        onChange(newValue);
      }
    },
    [onChange]
  );

  const typeSelectOptions = useMemo(() => {
    if (targetTypes) {
      return targetTypes.map((tt) => {
        return {
          value: tt.value,
          label: tt.type === 'profile' ? tt.title ?? tt.name ?? tt.resourceType ?? tt.value : tt.value,
        };
      });
    }
    return [];
  }, [targetTypes]);

  return (
    <Group spacing="xs" grow noWrap>
      {targetTypes && targetTypes.length > 1 && (
        <NativeSelect
          data-autofocus={props.autoFocus}
          data-testid="reference-input-resource-type-select"
          defaultValue={targetType?.resourceType}
          autoFocus={props.autoFocus}
          onChange={(e) => {
            const newValue = e.currentTarget.value;
            const newTargetType = targetTypes.find((tt) => tt.value === newValue);
            setTargetType(newTargetType);
          }}
          data={typeSelectOptions}
        />
      )}
      {!targetTypes && (
        <ResourceTypeInput
          autoFocus={props.autoFocus}
          testId="reference-input-resource-type-input"
          defaultValue={targetType?.resourceType as ResourceType}
          onChange={(newResourceType) => {
            if (newResourceType) {
              setTargetType({ type: 'resourceType', value: newResourceType, resourceType: newResourceType });
            } else {
              setTargetType(undefined);
            }
          }}
          name={props.name + '-resourceType'}
          placeholder="Resource Type"
        />
      )}
      <ResourceInput
        resourceType={targetType?.resourceType as ResourceType}
        name={props.name + '-id'}
        required={props.required}
        placeholder={props.placeholder}
        defaultValue={value}
        searchCriteria={searchCriteria}
        onChange={setValueHelper}
      />
    </Group>
  );
}

function createTargetTypes(resourceTypesAndProfileUrls: string[] | undefined): TargetType[] | undefined {
  if (
    !resourceTypesAndProfileUrls ||
    resourceTypesAndProfileUrls.length === 0 ||
    (resourceTypesAndProfileUrls.length === 1 && resourceTypesAndProfileUrls[0] === 'Resource')
  ) {
    return undefined;
  }

  const results: TargetType[] = [];
  for (const value of resourceTypesAndProfileUrls) {
    // is there a less hacky way to distinguish resourceType from profile URLs?
    if (value.includes('/')) {
      results.push({ type: 'profile', value });
    } else {
      results.push({ type: 'resourceType', value, resourceType: value });
    }
  }
  return results;
}

function getInitialTargetType(
  defaultValue: Reference | undefined,
  targetTypes: TargetType[] | undefined
): TargetType | undefined {
  const defaultValueResourceType = defaultValue?.reference?.split('/')[0];
  if (defaultValueResourceType) {
    const targetType = targetTypes?.find((tt) => tt.resourceType === defaultValueResourceType);
    if (targetType) {
      return targetType;
    }

    // An "orphaned" TargetType is created when defaultValue references a resourceType
    // that is not yet represented in targetTypes due to profile URL resolution to resource type
    // that has yet to occur. An orphan can also occur if a defaultValue is provided
    // but targetTypes is not.
    return {
      type: 'resourceType',
      value: defaultValueResourceType,
      resourceType: defaultValueResourceType,
    };
  }

  if (targetTypes && targetTypes.length > 0) {
    return targetTypes[0];
  }

  return undefined;
}

type PartialStructureDefinition = Pick<StructureDefinition, 'type' | 'name' | 'title'>;

interface ResourceTypeGraphQLResponse {
  readonly data: {
    readonly StructureDefinitionList: PartialStructureDefinition[];
  };
}

async function fetchResourceTypeOfProfile(
  medplum: MedplumClient,
  profileUrl: string
): Promise<PartialStructureDefinition | undefined> {
  const profile = tryGetProfile(profileUrl);
  if (profile) {
    return { type: profile.type, name: profile.name, title: profile.title };
  }

  const query = `{
      StructureDefinitionList(url: "${profileUrl}", _sort: "_lastUpdated", _count: 1) {
        type,
        name,
        title,
      }
    }`.replace(/\s+/g, ' ');

  const response = (await medplum.graphql(query)) as ResourceTypeGraphQLResponse;

  return response.data.StructureDefinitionList[0];
}

function shouldFetchResourceType(targetType: TargetType): targetType is ProfileTargetType {
  return targetType.type === 'profile' && !targetType?.error && isEmpty(targetType.resourceType);
}
