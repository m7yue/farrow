import { FormatFields, FormatType, FormatTypes, isNamedFormatType } from 'farrow-schema/formatter'
import { FormatEntries, FormatResult, FormatApi } from './toJSON'

export const isInlineType = (input: FormatType) => {
  if (isNamedFormatType(input)) {
    return !input.name
  }
  return true
}

const getTypeName = (input: FormatType): string | null => {
  if (isNamedFormatType(input) && input.name) {
    return input.name
  }
  return null
}

const transformComment = (text: string) => {
  return text
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
    .join('\n*\n* ')
}

const applyIndentForEachLine = (text: string, indent: number) => {
  const indentText = ' '.repeat(indent)
  return text
    .split('\n')
    .map((item) => indentText + item)
    .join('\n')
}

const attachComment = (result: string, options: { [key: string]: string | undefined }) => {
  const list = Object.entries(options)
    .map(([key, value]) => {
      return value ? `* @${key} ${transformComment(value.trim())}` : ''
    })
    .filter(Boolean)

  if (list.length === 0) return result

  const comment = `/**\n${list.join('\n')}\n*/\n`

  return comment + result
}

const getTypeNameById = (typeId: number | string): string => {
  return `Type${typeId}`
}

export const getFieldType = (typeId: number, types: FormatTypes, indent = 2): string => {
  const fieldType = types[typeId]

  const typeName = getTypeName(fieldType)

  if (typeName) {
    return typeName
  }

  if (!isInlineType(fieldType)) {
    return getTypeNameById(typeId)
  }

  if (fieldType.type === 'Scalar') {
    return fieldType.valueType
  }

  if (fieldType.type === 'Record') {
    return `Record<string, ${getFieldType(fieldType.valueTypeId, types)}>`
  }

  if (fieldType.type === 'Literal') {
    const literal = typeof fieldType.value === 'string' ? `"${fieldType.value}"` : fieldType.value
    return `${literal}`
  }

  if (fieldType.type === 'Nullable') {
    return `${getFieldType(fieldType.itemTypeId, types)} | null | undefined`
  }

  if (fieldType.type === 'List') {
    return `(${getFieldType(fieldType.itemTypeId, types)})[]`
  }

  if (fieldType.type === 'Union') {
    return fieldType.itemTypes.map((itemType) => getFieldType(itemType.typeId, types)).join(' | ')
  }

  if (fieldType.type === 'Intersect') {
    return fieldType.itemTypes.map((itemType) => getFieldType(itemType.typeId, types)).join(' & ')
  }

  if (fieldType.type === 'Struct') {
    return `{\n${applyIndentForEachLine(getFieldsType(fieldType.fields, types).join(',\n'), indent)}\n${' '.repeat(
      indent - 2,
    )}}`
  }

  if (
    fieldType.type === 'Strict' ||
    fieldType.type === 'NonStrict' ||
    fieldType.type === 'ReadOnly' ||
    fieldType.type === 'ReadOnlyDeep'
  ) {
    return getFieldType(fieldType.itemTypeId, types)
  }

  if (fieldType.type === 'Tuple') {
    return `[${fieldType.itemTypes.map((itemType) => getFieldType(itemType.typeId, types)).join(', ')}]`
  }

  throw new Error(`Unsupported field: ${JSON.stringify(fieldType, null, 2)}`)
}

export const getFieldsType = (fields: FormatFields, types: FormatTypes): string[] => {
  return Object.entries(fields).map(([key, field]) => {
    const fieldType = types[field.typeId]
    let result = ''

    if (fieldType.type === 'Nullable') {
      result = `${key}?: ${getFieldType(field.typeId, types)}`
    } else {
      result = `${key}: ${getFieldType(field.typeId, types)}`
    }

    return attachComment(result, {
      remarks: field.description,
      deprecated: field.deprecated,
    })
  })
}

export type CodegenOptions = {
  /**
   * emit ApiClient or not
   * default: true
   */
  apiClient?: boolean

  /**
   * add ts-nocheck or not
   */
  noCheck?: boolean | string
}

export const PREFIX_COMMENT = `
/**
 * This file was generated by farrow-api
 * Don't modify it manually
*/
`.trim()

export const JSON_TYPE_DECLARATION = `
export type JsonType =
  | number
  | string
  | boolean
  | null
  | undefined
  | JsonType[]
  | { toJSON(): string }
  | { [key: string]: JsonType }
`.trim()

export const codegen = (formatResult: FormatResult, options?: CodegenOptions): string => {
  const exportSet = new Set<string>()

  const handleTypeDeclaration = (formatType: FormatType): string => {
    if (isInlineType(formatType)) {
      return ''
    }

    if (formatType.type === 'Object' || formatType.type === 'Struct') {
      const typeName = formatType.name!
      const fields = getFieldsType(formatType.fields, formatResult.types)

      if (!typeName) {
        throw new Error(`Empty name of Object/Struct, fields: {${Object.keys(formatType.fields)}}`)
      }

      if (exportSet.has(typeName)) {
        throw new Error(`Duplicate Object/Struct type name: ${typeName}`)
      }

      exportSet.add(typeName)

      const source = `
/**
 * @label ${typeName}
*/
export type ${typeName} = {
${applyIndentForEachLine(fields.join(',\n'), 2)}
}
`
      return source.trim()
    }

    if (formatType.type === 'Union') {
      const typeName = formatType.name!
      const expression = formatType.itemTypes.map((itemType) => getFieldType(itemType.typeId, formatResult.types))
      const source = `
/**
 * @label ${typeName}
*/
export type ${typeName} =
${applyIndentForEachLine(expression.map((item) => `| ${item}`).join('\n'), 2)}
      `

      return source.trim()
    }

    if (formatType.type === 'Intersect') {
      const typeName = formatType.name!
      const expression = formatType.itemTypes.map((itemType) => getFieldType(itemType.typeId, formatResult.types))
      const source = `
/**
 * @label ${typeName}
*/
export type ${typeName} =
${applyIndentForEachLine(expression.map((item) => `& ${item}`).join('\n'), 2)}
`

      return source.trim()
    }

    if (formatType.type === 'Tuple') {
      const typeName = formatType.name!
      const expression = formatType.itemTypes.map((itemType) => getFieldType(itemType.typeId, formatResult.types))

      return `
/**
 * @label ${typeName}
*/
export type ${typeName} = [
${applyIndentForEachLine(expression.join(',\n'), 2)}
]
`.trim()
    }

    throw new Error(`Unsupported type of ${JSON.stringify(formatType, null, 2)}`)
  }

  const handleTypeDeclarations = (formatTypes: FormatTypes) => {
    const result = [] as string[]
    for (const key in formatTypes) {
      const formatType = formatTypes[key]
      const formattedType = handleTypeDeclaration(formatType)
      if (formattedType) {
        result.push(formattedType)
      }
    }
    return result
  }

  const typeDeclarations = [JSON_TYPE_DECLARATION, ...handleTypeDeclarations(formatResult.types)]

  const variableDeclarations: string[] = []

  if (options?.apiClient !== false) {
    typeDeclarations.push(
      `
export type ApiClientLoaderInput = {
  path: string[]
  input: JsonType
}
`.trim(),
    )

    typeDeclarations.push(
      `
export interface ApiClientLoaderOptions {
  batch?: boolean
  stream?: boolean
  cache?: boolean
}
`.trim(),
    )

    typeDeclarations.push(
      `
export type ApiClientOptions = {
  loader: (input: ApiClientLoaderInput, options?: ApiClientLoaderOptions) => Promise<JsonType>
}
`.trim(),
    )

    const handleApi = (api: FormatApi, path: string[]) => {
      const inputType = getFieldType(api.input.typeId, formatResult.types)
      const outputType = getFieldType(api.output.typeId, formatResult.types, 4)
      return `
(input: ${inputType}, loaderOptions?: ApiClientLoaderOptions) => {
  return options.loader(
    {
      path: [${path.map((item) => `'${item}'`).join(', ')}],
      input: input as JsonType,
    },
    loaderOptions
  ) as Promise<${outputType}>
}
    `.trim()
    }

    const handleEntries = (entries: FormatEntries, path: string[] = [], indent = 2): string => {
      const fields = [] as string[]

      for (const key in entries.entries) {
        const field = entries.entries[key]

        if (field.type === 'Api') {
          const sourceText = handleApi(field, [...path, key])
          const result = `${key}: ${sourceText}`

          fields.push(
            attachComment(result, {
              remarks: field.description,
              deprecated: field.deprecated,
              [`param input -`]: field.input.description,
              returns: field.output.description,
            }),
          )
        } else {
          fields.push(`${key}: ${handleEntries(field, [...path, key])}`)
        }
      }

      return `{\n${applyIndentForEachLine(fields.join(',\n'), indent)}\n${' '.repeat(indent - 2)}}`
    }

    variableDeclarations.push(
      `
export const createApiClient = (options: ApiClientOptions) => {
  return ${handleEntries(formatResult.entries, [], 4)}
}
`.trim(),
    )
  }

  let source = [PREFIX_COMMENT, ...typeDeclarations, ...variableDeclarations].join('\n\n')

  if (options?.noCheck) {
    if (typeof options.noCheck === 'string') {
      source = `
// @ts-nocheck ${options.noCheck}
${source}
      `
    } else {
      source = `
// @ts-nocheck
${source}
      `
    }
  }

  return source.trim()
}
