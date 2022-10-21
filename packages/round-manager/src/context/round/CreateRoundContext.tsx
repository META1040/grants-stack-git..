import {
  ProgressStatus,
  Round,
  StorageProtocolID,
} from "../../features/api/types";
import React, { createContext, useContext, useReducer } from "react";
import { saveToIPFS } from "../../features/api/ipfs";
import { useWallet } from "../../features/common/Auth";
import { deployRoundContract } from "../../features/api/round";
import { waitForSubgraphSyncTo } from "../../features/api/subgraph";
import { SchemaQuestion } from "../../features/api/utils";
import { datadogLogs } from "@datadog/browser-logs";
import { Signer } from "@ethersproject/abstract-signer";

export interface CreateRoundState {
  IPFSCurrentStatus: ProgressStatus;
  contractDeploymentStatus: ProgressStatus;
  indexingStatus: ProgressStatus;
}

export type CreateRoundData = {
  roundMetadataWithProgramContractAddress: Round["roundMetadata"];
  applicationQuestions: {
    lastUpdatedOn: number;
    applicationSchema: SchemaQuestion[];
  };
  round: Round;
};

export const initialCreateRoundState: CreateRoundState = {
  IPFSCurrentStatus: ProgressStatus.NOT_STARTED,
  contractDeploymentStatus: ProgressStatus.NOT_STARTED,
  indexingStatus: ProgressStatus.NOT_STARTED,
};

export const CreateRoundContext = createContext<
  { state: CreateRoundState; dispatch: Dispatch } | undefined
>(undefined);

type Dispatch = (action: Action) => void;

interface Action {
  type: ActionType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any;
}

enum ActionType {
  SET_STORING_STATUS = "SET_STORING_STATUS",
  SET_DEPLOYMENT_STATUS = "SET_DEPLOYMENT_STATUS",
  SET_INDEXING_STATUS = "SET_INDEXING_STATUS",
  RESET_TO_INITIAL_STATE = "RESET_TO_INITIAL_STATE",
}

const createRoundReducer = (state: CreateRoundState, action: Action) => {
  switch (action.type) {
    case ActionType.SET_STORING_STATUS:
      return { ...state, IPFSCurrentStatus: action.payload.IPFSCurrentStatus };
    case ActionType.SET_DEPLOYMENT_STATUS:
      return {
        ...state,
        contractDeploymentStatus: action.payload.contractDeploymentStatus,
      };
    case ActionType.SET_INDEXING_STATUS:
      return {
        ...state,
        indexingStatus: action.payload.indexingStatus,
      };
    case ActionType.RESET_TO_INITIAL_STATE: {
      return initialCreateRoundState;
    }
  }
  return state;
};

export const CreateRoundProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [state, dispatch] = useReducer(
    createRoundReducer,
    initialCreateRoundState
  );

  const providerProps = {
    state,
    dispatch,
  };

  return (
    <CreateRoundContext.Provider value={providerProps}>
      {children}
    </CreateRoundContext.Provider>
  );
};

interface _createRoundParams {
  dispatch: Dispatch;
  signerOrProvider: Signer;
  createRoundData: CreateRoundData;
}

const _createRound = async ({
  dispatch,
  signerOrProvider,
  createRoundData,
}: _createRoundParams) => {
  const {
    roundMetadataWithProgramContractAddress,
    applicationQuestions,
    round,
  } = createRoundData;
  dispatch({
    type: ActionType.RESET_TO_INITIAL_STATE,
  });
  try {
    datadogLogs.logger.info(`_createRound: ${round}`);

    const { roundMetadataIpfsHash, applicationSchemaIpfsHash } =
      await storeDocuments(
        dispatch,
        roundMetadataWithProgramContractAddress,
        applicationQuestions
      );

    const roundContractInputsWithPointers = {
      ...round,
      store: {
        protocol: StorageProtocolID.IPFS,
        pointer: roundMetadataIpfsHash,
      },
      applicationStore: {
        protocol: StorageProtocolID.IPFS,
        pointer: applicationSchemaIpfsHash,
      },
    };

    const transactionBlockNumber = await deployContract(
      dispatch,
      roundContractInputsWithPointers,
      signerOrProvider
    );

    await waitForSubgraphToUpdate(
      dispatch,
      signerOrProvider,
      transactionBlockNumber
    );
  } catch (error) {
    datadogLogs.logger.error(
      `error: _createRound ${error}. Data : ${createRoundData}`
    );

    console.error("Error while creating round: ", error);
  }
};

export const useCreateRound = () => {
  const context = useContext(CreateRoundContext);
  if (context === undefined) {
    throw new Error("useCreateRound must be used within a CreateRoundProvider");
  }

  const { signer: walletSigner } = useWallet();

  const createRound = (createRoundData: CreateRoundData) => {
    return _createRound({
      dispatch: context.dispatch,
      signerOrProvider: walletSigner as Signer,
      createRoundData,
    });
  };

  return {
    createRound,
    IPFSCurrentStatus: context.state.IPFSCurrentStatus,
    contractDeploymentStatus: context.state.contractDeploymentStatus,
    indexingStatus: context.state.indexingStatus,
  };
};

async function storeDocuments(
  dispatch: (action: Action) => void,
  roundMetadataWithProgramContractAddress: CreateRoundData["roundMetadataWithProgramContractAddress"],
  applicationQuestions: CreateRoundData["applicationQuestions"]
) {
  try {
    dispatch({
      type: ActionType.SET_STORING_STATUS,
      payload: { IPFSCurrentStatus: ProgressStatus.IN_PROGRESS },
    });

    const [roundMetadataIpfsHash, applicationSchemaIpfsHash] =
      await Promise.all([
        saveToIPFS({
          content: roundMetadataWithProgramContractAddress,
          metadata: {
            name: "round-metadata",
          },
        }),
        saveToIPFS({
          content: applicationQuestions,
          metadata: {
            name: "application-schema",
          },
        }),
      ]);

    dispatch({
      type: ActionType.SET_STORING_STATUS,
      payload: { IPFSCurrentStatus: ProgressStatus.IS_SUCCESS },
    });

    return {
      roundMetadataIpfsHash,
      applicationSchemaIpfsHash,
    };
  } catch (e) {
    dispatch({
      type: ActionType.SET_STORING_STATUS,
      payload: { IPFSCurrentStatus: ProgressStatus.IS_ERROR },
    });
    throw e;
  }
}

async function deployContract(
  dispatch: (action: Action) => void,
  round: Round,
  signerOrProvider: Signer
): Promise<number> {
  try {
    dispatch({
      type: ActionType.SET_DEPLOYMENT_STATUS,
      payload: { contractDeploymentStatus: ProgressStatus.IN_PROGRESS },
    });
    const { transactionBlockNumber } = await deployRoundContract(
      round,
      signerOrProvider
    );

    dispatch({
      type: ActionType.SET_DEPLOYMENT_STATUS,
      payload: { contractDeploymentStatus: ProgressStatus.IS_SUCCESS },
    });

    return transactionBlockNumber;
  } catch (e) {
    dispatch({
      type: ActionType.SET_DEPLOYMENT_STATUS,
      payload: { contractDeploymentStatus: ProgressStatus.IS_ERROR },
    });

    throw e;
  }
}

async function waitForSubgraphToUpdate(
  dispatch: (action: Action) => void,
  signerOrProvider: Signer,
  transactionBlockNumber: number
) {
  try {
    dispatch({
      type: ActionType.SET_INDEXING_STATUS,
      payload: { indexingStatus: ProgressStatus.IN_PROGRESS },
    });

    const chainId = await signerOrProvider.getChainId();
    await waitForSubgraphSyncTo(chainId, transactionBlockNumber);

    dispatch({
      type: ActionType.SET_INDEXING_STATUS,
      payload: { indexingStatus: ProgressStatus.IS_SUCCESS },
    });
  } catch (e) {
    dispatch({
      type: ActionType.SET_INDEXING_STATUS,
      payload: { indexingStatus: ProgressStatus.IS_ERROR },
    });
    throw e;
  }
}
