import * as request from 'superagent'
import { SuperAgentStatic } from 'superagent'
import pRetry from 'p-retry'
import { promises as fs } from 'fs'
import path from 'path'
import cliProgress, { SingleBar } from 'cli-progress'

import { Config, Data, Network } from '../types'
import { BAL } from '../constants'
import { getCutoffBlock } from '../utils'

const BASE_URL = 'https://dune.com'
const GRAPH_URL = 'https://core-hsr.duneanalytics.com/v1/graphql'

interface DuneQueryParameter {
  key: string
  type: 'number' | 'date' | 'text'
  value: string
}

interface DuneConfig {
  username: string
  password: string
  // queryId: number
}

class DuneConnection {
  private readonly username: string
  private readonly password: string

  private csrf: string
  private authRefresh: string
  private token: string
  private agent: ReturnType<SuperAgentStatic['agent']>

  static async connect(config: DuneConfig): Promise<DuneConnection> {
    const dune = new DuneConnection(config)
    await dune.connect()
    return dune
  }

  constructor(config: DuneConfig) {
    this.username = config.username
    this.password = config.password
  }

  private async login() {
    const bar = new cliProgress.SingleBar(
      { format: `Connecting to Dune... {bar} {percentage}%` },
      cliProgress.Presets.shades_grey,
    )
    bar.start(3, 0)
    const loginUrl = BASE_URL + '/auth/login'
    const csrfUrl = BASE_URL + '/api/auth/csrf'
    const authUrl = BASE_URL + '/api/auth'
    const sessionUrl = BASE_URL + '/api/auth/session'

    // Visit the login page
    await this.agent.get(loginUrl)
    bar.increment()

    // Get csrf token
    this.csrf = (await this.agent.post(csrfUrl)).body.csrf

    // Try to log in
    const authResp = await this.agent.post(authUrl).send({
      action: 'login',
      username: this.username,
      password: this.password,
      csrf: this.csrf,
      next: BASE_URL,
    })
    bar.increment()

    // This is a bit fragile, but superagent doesn't seem to expose getting cookies
    this.authRefresh = (authResp as any)
      .toJSON()
      .req.headers.cookie.split('auth-refresh=')[1]
      .split('; ')[0]

    const resp = await this.agent.post(sessionUrl)
    if (resp.statusCode === 200) {
      this.token = resp.body.token
      bar.increment()
    } else {
      bar.stop()
      throw new Error('Error fetching auth token')
    }
  }

  private async connect() {
    this.csrf = null
    this.authRefresh = null
    this.token = null
    this.agent = request.agent().set({
      origin: BASE_URL,
      'sec-ch-ua':
        '" Not A;Brand";v="99", "Chromium";v="90", "Google Chrome";v="90"',
      'sec-ch-ua-mobile': '?0',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      dnt: '1',
    })
    await this.login()
  }

  private parseDuneResponse<TData extends {}>(data: {
    data: { get_result_by_result_id: { data: TData }[] }
  }) {
    // Parses user data and execution date from query result.
    return data.data.get_result_by_result_id.map((rec) => rec.data)
  }

  private async handleDuneRequest(queryData: {}) {
    // Parses response for errors by key and raises runtime error if they exist.
    const resp = await this.agent
      .set({ authorization: `Bearer ${this.token}` })
      .post(GRAPH_URL)
      .send(queryData)

    if (resp.body.errors) {
      throw new Error(
        `Dune API Request failed: ${JSON.stringify(resp.body.errors)}`,
      )
    }

    return resp.body
  }

  private async queryResult(resultId: number) {
    // Fetch the result for a query
    const queryData = {
      operationName: 'FindResultDataByResult',
      variables: { result_id: resultId },
      query:
        'query FindResultDataByResult($result_id: uuid!) {\n  query_results(where: {id: {_eq: $result_id}}) {\n    id\n    job_id\n    error\n    runtime\n    generated_at\n    columns\n    __typename\n  }\n  get_result_by_result_id(args: {want_result_id: $result_id}) {\n    data\n    __typename\n  }\n}\n',
    }
    return this.handleDuneRequest(queryData)
  }

  private async queryResultId(
    queryId: number,
    parameters: DuneQueryParameter[],
  ) {
    // Fetch the query result id for a query
    const queryData = {
      operationName: 'GetResult',
      variables: { query_id: queryId, parameters },
      query: `query GetResult($query_id: Int!, $parameters: [Parameter!]) { get_result_v2(query_id: $query_id, parameters: $parameters) { job_id result_id error_id __typename } }`,
    }
    const data = await this.handleDuneRequest(queryData)
    return data.data.get_result_v2.result_id
  }

  private async executeQuery(queryId: number) {
    // Executes query according to the given id.
    const queryData = {
      operationName: 'ExecuteQuery',
      variables: {
        query_id: queryId,
        parameters: [],
      },
      query:
        'mutation ExecuteQuery($query_id: Int!, $parameters: [Parameter!]!) {\n  execute_query(query_id: $query_id, parameters: $parameters) {\n    job_id\n    __typename\n  }\n}\n',
    }
    return this.handleDuneRequest(queryData)
  }

  private async executeAndAwaitResults(
    queryId: number,
    pingFrequency: number,
    parameters: DuneQueryParameter[],
  ) {
    // Executes query by ID and awaits completion.
    // Since queries take some time to complete we include a sleep parameter
    // since there is no purpose in constantly pinging for results
    await this.executeQuery(queryId)
    const resultId = await pRetry<number>(
      async () => {
        const maybeResultId = await this.queryResultId(queryId, parameters)
        if (!maybeResultId) throw new Error('No result ID')
        return maybeResultId
      },
      {
        minTimeout: pingFrequency,
      },
    )
    const data = await this.queryResult(resultId)
    return this.parseDuneResponse(data)
  }

  private async openQuery(queryFilepath: string) {
    return fs.readFile(path.join('./src/fetch/sql/', queryFilepath), 'utf8')
  }

  private async initiateNewQuery(
    queryId: number,
    query: string,
    queryName: string,
    datasetId: number,
    parameters: DuneQueryParameter[],
  ) {
    const queryData = {
      operationName: 'UpsertQuery',
      variables: {
        favs_last_24h: false,
        favs_last_7d: false,
        favs_last_30d: false,
        favs_all_time: true,
        object: {
          id: queryId, // added
          schedule: null,
          dataset_id: datasetId,
          name: queryName,
          query,
          user_id: 84,
          description: '',
          is_archived: false,
          is_temp: false,
          parameters,
          visualizations: {
            data: [
              {
                type: 'table',
                name: 'Query results',
                options: {},
              },
            ],
            on_conflict: {
              constraint: 'visualizations_pkey',
              update_columns: ['name', 'options'],
            },
          },
        },
        on_conflict: {
          constraint: 'queries_pkey',
          update_columns: [
            'dataset_id',
            'name',
            'description',
            'query',
            'schedule',
            'is_archived',
            'is_temp',
            'tags',
            'parameters',
          ],
        },
        session_id: 84,
      },
      query:
        'mutation UpsertQuery($session_id: Int!, $object: queries_insert_input!, $on_conflict: queries_on_conflict!, $favs_last_24h: Boolean! = false, $favs_last_7d: Boolean! = false, $favs_last_30d: Boolean! = false, $favs_all_time: Boolean! = true) {\n  insert_queries_one(object: $object, on_conflict: $on_conflict) {\n    ...Query\n    favorite_queries(where: {user_id: {_eq: $session_id}}, limit: 1) {\n      created_at\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment Query on queries {\n  ...BaseQuery\n  ...QueryVisualizations\n  ...QueryForked\n  ...QueryUsers\n  ...QueryFavorites\n  __typename\n}\n\nfragment BaseQuery on queries {\n  id\n  dataset_id\n  name\n  description\n  query\n  is_private\n  is_temp\n  is_archived\n  created_at\n  updated_at\n  schedule\n  tags\n  parameters\n  __typename\n}\n\nfragment QueryVisualizations on queries {\n  visualizations {\n    id\n    type\n    name\n    options\n    created_at\n    __typename\n  }\n  __typename\n}\n\nfragment QueryForked on queries {\n  forked_query {\n    id\n    name\n    user {\n      name\n      __typename\n    }\n    __typename\n  }\n  __typename\n}\n\nfragment QueryUsers on queries {\n  user {\n    ...User\n    __typename\n  }\n  __typename\n}\n\nfragment User on users {\n  id\n  name\n  profile_image_url\n  __typename\n}\n\nfragment QueryFavorites on queries {\n  query_favorite_count_all @include(if: $favs_all_time) {\n    favorite_count\n    __typename\n  }\n  query_favorite_count_last_24h @include(if: $favs_last_24h) {\n    favorite_count\n    __typename\n  }\n  query_favorite_count_last_7d @include(if: $favs_last_7d) {\n    favorite_count\n    __typename\n  }\n  query_favorite_count_last_30d @include(if: $favs_last_30d) {\n    favorite_count\n    __typename\n  }\n  __typename\n}\n',
    }
    return this.handleDuneRequest(queryData)
  }

  private async queryInitiateExecuteAwait(
    queryId: number,
    queryFilepath: string,
    queryName: string,
    datasetId: number,
    parameters: DuneQueryParameter[],
    bar: SingleBar,
    pingFrequency: number = 10,
    maxRetries: number = 2,
  ) {
    // Pushes new query to dune and executes, awaiting query completion
    bar.update({ status: 'Opening query' })
    const query = await this.openQuery(queryFilepath)

    bar.update({ status: 'Initiating new query' })
    await this.initiateNewQuery(
      queryId,
      query,
      queryName,
      datasetId,
      parameters,
    )

    const result = await pRetry(
      async () =>
        this.executeAndAwaitResults(queryId, pingFrequency, parameters),
      {
        retries: maxRetries,
        onFailedAttempt: async (error) => {
          bar.update({ status: `Execution fetching failed, retrying` })
          console.error(error)
          await this.login()
        },
      },
    )
    bar.update(bar.getTotal(), { status: `Done (${result.length} records)` })
    bar.stop()
    return result
  }

  public async fetch(
    queryId: number,
    queryFilepath: string,
    queryName: string,
    datasetId: number,
    parameters: DuneQueryParameter[],
  ) {
    const bar = new cliProgress.SingleBar(
      { format: `${queryName}: {status}` },
      cliProgress.Presets.shades_grey,
    )
    bar.start(3, 0, { status: 'Initiating' })
    return this.queryInitiateExecuteAwait(
      queryId,
      queryFilepath,
      queryName,
      datasetId,
      parameters,
      bar,
    )
  }
}

const getBlockNumberParam = (
  config: Config,
  network: Network,
): DuneQueryParameter => ({
  key: 'BlockNumber',
  type: 'number',
  value: getCutoffBlock(config, network).toString(),
})

const getQueries = (
  config: Config,
): Record<
  keyof Data['dune'],
  {
    queryName: string
    parameters: DuneQueryParameter[]
    queryFilepath: string
    queryId: number
    datasetId: number
  }
> => ({
  vlCVX: {
    queryFilepath: 'mainnet_vlcvx_holders.sql',
    queryName: 'vlCVX holders',
    parameters: [getBlockNumberParam(config, 'mainnet')],
    queryId: 855391,
    datasetId: 4,
  },
  balMainnet: {
    queryFilepath: 'token_balances.sql',
    queryName: 'BAL holders (Mainnet)',
    parameters: [
      getBlockNumberParam(config, 'mainnet'),
      {
        key: 'Address',
        type: 'text',
        value: BAL.mainnet,
      },
    ],
    queryId: 493891,
    datasetId: 4,
  },
  balPolygon: {
    queryFilepath: 'token_balances.sql',
    queryName: 'BAL holders (Polygon)',
    parameters: [
      getBlockNumberParam(config, 'polygon'),
      {
        key: 'Address',
        type: 'text',
        value: BAL.polygon,
      },
    ],
    queryId: 511724,
    datasetId: 7,
  },
  // Dune doesn't support Arbitrum yet :(
  // balArbitrum: {
  //   queryFilepath: 'token_balances.sql',
  //   queryName: 'BAL holders (Arbitrum)',
  //   parameters: [
  //     getBlockNumberParam(config, 'arbitrum'),
  //     {
  //       key: 'Address',
  //       type: 'text',
  //       value: BAL.arbitrum,
  //     },
  //   ],
  //   queryId: 493891,
  //   datasetId: 4,
  // },
  bveCVX: {
    queryFilepath: 'token_balances.sql',
    queryName: 'bveCVX holders (Mainnet)',
    parameters: [
      getBlockNumberParam(config, 'mainnet'),
      {
        key: 'Address',
        type: 'text',
        value: '0xfd05D3C7fe2924020620A8bE4961bBaA747e6305',
      },
    ],
    queryId: 855374,
    datasetId: 4,
  },
})

export const fetchDuneData = async (config: Config): Promise<Data['dune']> => {
  const duneConfig = {
    username: process.env.DUNE_USER,
    password: process.env.DUNE_PASSWORD,
  }
  const dune = await DuneConnection.connect(duneConfig)

  // Run all queries in sequence to avoid losing the Dune connection
  // Pretty dumb, all in memory – don't ask for too much
  const results: Data['dune'] = {
    vlCVX: [],
    balMainnet: [],
    balPolygon: [],
    bveCVX: [],
  }
  for (const [
    key,
    { queryId, queryFilepath, queryName, parameters, datasetId },
  ] of Object.entries(getQueries(config))) {
    results[key] = await dune.fetch(
      queryId,
      queryFilepath,
      queryName,
      datasetId,
      parameters,
    )
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  return results
}
