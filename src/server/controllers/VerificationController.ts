import { NextFunction, Request, Response, Router } from "express";
import cors from "cors";
import {
  SourcifyChainMap,
  CheckedContract,
  checkFiles,
  useAllSources,
  PathBuffer,
  PathContent,
  isEmpty,
  getBytecode,
  getIpfsGateway,
  performFetch,
  verifyCreate2,
  getAllMetadataAndSourcesFromSolcJson,
} from "@ethereum-sourcify/lib-sourcify";
import { decode as bytecodeDecode } from "@ethereum-sourcify/bytecode-utils";
import { IVerificationService } from "../services/VerificationService";
import BaseController from "./BaseController";
import { IController } from "../../common/interfaces";
import {
  addRemoteFile,
  checkContractsInSession,
  ContractWrapperMap,
  extractFiles,
  FILE_ENCODING,
  getSessionJSON,
  isVerifiable,
  LegacyVerifyRequest,
  saveFiles,
  SendableContract,
  stringifyInvalidAndMissing,
  validateAddresses,
  validateRequest,
  verifyContractsInSession,
  processRequestFromEtherscan,
  getMappedSourcesFromJsonInput,
  stringToBase64,
  Create2VerifyRequest,
  extractFilesFromJSON,
  SessionCreate2VerifyRequest,
  getMetadataFromCompiler,
} from "./VerificationController-util";
import { body } from "express-validator";
import {
  BadRequestError,
  NotFoundError,
  ValidationError,
} from "../../common/errors";
import {
  checkSupportedChainId,
  sourcifyChainsMap,
} from "../../sourcify-chains";
import config from "../../config";
import { StatusCodes } from "http-status-codes";
import { IRepositoryService } from "../services/RepositoryService";

export default class VerificationController
  extends BaseController
  implements IController
{
  router: Router;
  sourcifyChainsMap: SourcifyChainMap;
  verificationService: IVerificationService;
  repositoryService: IRepositoryService;

  constructor(
    verificationService: IVerificationService,
    repositoryService: IRepositoryService
  ) {
    super();
    this.verificationService = verificationService;
    this.repositoryService = repositoryService;
    this.sourcifyChainsMap = sourcifyChainsMap;
    this.router = Router();
  }

  private getSessionDataEndpoint = async (req: Request, res: Response) => {
    res.send(getSessionJSON(req.session));
  };

  private addInputFilesEndpoint = async (req: Request, res: Response) => {
    validateRequest(req);
    let inputFiles: PathBuffer[] | undefined;
    if (req.query.url) {
      inputFiles = await addRemoteFile(req.query);
    } else {
      inputFiles = extractFiles(req, true);
    }
    if (!inputFiles)
      throw new ValidationError([{ param: "files", msg: "No files found" }]);
    const pathContents: PathContent[] = inputFiles.map((pb) => {
      return { path: pb.path, content: pb.buffer.toString(FILE_ENCODING) };
    });

    const session = req.session;
    const newFilesCount = saveFiles(pathContents, session);
    if (newFilesCount) {
      await checkContractsInSession(session);
      await verifyContractsInSession(
        session.contractWrappers,
        session,
        this.verificationService,
        this.repositoryService
      );
    }
    res.send(getSessionJSON(session));
  };

  private addInputSolcJsonEndpoint = async (req: Request, res: Response) => {
    validateRequest(req);
    const inputFiles = extractFiles(req, true);
    if (!inputFiles)
      throw new ValidationError([{ param: "files", msg: "No files found" }]);

    const compilerVersion = req.body.compilerVersion;

    for (const inputFile of inputFiles) {
      let solcJson;
      try {
        solcJson = JSON.parse(inputFile.buffer.toString());
      } catch (error: any) {
        throw new BadRequestError(
          `Couldn't parse JSON ${inputFile.path}. Make sure the contents of the file are syntaxed correctly.`
        );
      }

      const metadataAndSources = await getAllMetadataAndSourcesFromSolcJson(
        solcJson,
        compilerVersion
      );
      const metadataAndSourcesPathContents: PathContent[] =
        metadataAndSources.map((pb) => {
          return { path: pb.path, content: pb.buffer.toString(FILE_ENCODING) };
        });

      const session = req.session;
      const newFilesCount = saveFiles(metadataAndSourcesPathContents, session);
      if (newFilesCount) {
        await checkContractsInSession(session);
      }
      res.send(getSessionJSON(session));
    }
  };

  private restartSessionEndpoint = async (req: Request, res: Response) => {
    req.session.destroy((error: Error) => {
      let msg = "";
      let statusCode = null;

      if (error) {
        msg = "Error in clearing session";
        statusCode = StatusCodes.INTERNAL_SERVER_ERROR;
      } else {
        msg = "Session successfully cleared";
        statusCode = StatusCodes.OK;
      }

      res.status(statusCode).send(msg);
    });
  };

  private verifyContractsInSessionEndpoint = async (
    req: Request,
    res: Response
  ) => {
    const session = req.session;
    if (!session.contractWrappers || isEmpty(session.contractWrappers)) {
      throw new BadRequestError("There are currently no pending contracts.");
    }

    const receivedContracts: SendableContract[] = req.body.contracts;

    const verifiable: ContractWrapperMap = {};
    for (const receivedContract of receivedContracts) {
      const id = receivedContract.verificationId;
      const contractWrapper = session.contractWrappers[id];
      if (contractWrapper) {
        contractWrapper.address = receivedContract.address;
        contractWrapper.chainId = receivedContract.chainId;
        /* contractWrapper.contextVariables = receivedContract.contextVariables; */
        contractWrapper.creatorTxHash = receivedContract.creatorTxHash;
        if (isVerifiable(contractWrapper)) {
          verifiable[id] = contractWrapper;
        }
      }
    }

    await verifyContractsInSession(
      verifiable,
      session,
      this.verificationService,
      this.repositoryService
    );
    res.send(getSessionJSON(session));
  };

  private addInputContractEndpoint = async (req: Request, res: Response) => {
    validateRequest(req);

    const address: string = req.body.address;
    const chainId: string = req.body.chainId;

    const sourcifyChain = this.verificationService.supportedChainsMap[chainId];

    const bytecode = await getBytecode(sourcifyChain, address);

    const { ipfs: metadataIpfsCid } = bytecodeDecode(bytecode);

    if (!metadataIpfsCid) {
      throw new BadRequestError(
        "The contract doesn't have a metadata IPFS CID"
      );
    }

    const ipfsUrl = `${getIpfsGateway()}${metadataIpfsCid}`;
    const metadataFileName = "metadata.json";
    const retrievedMetadataText = await performFetch(ipfsUrl);

    if (!retrievedMetadataText)
      throw new Error(`Could not retrieve metadata from ${ipfsUrl}`);
    const pathContents: PathContent[] = [];

    const retrievedMetadataBase64 = Buffer.from(retrievedMetadataText).toString(
      "base64"
    );

    pathContents.push({
      path: metadataFileName,
      content: retrievedMetadataBase64,
    });

    const session = req.session;

    const newFilesCount = saveFiles(pathContents, session);
    if (newFilesCount) {
      await checkContractsInSession(session);
      // verifyValidated fetches missing files from the contract
      await verifyContractsInSession(
        session.contractWrappers,
        session,
        this.verificationService,
        this.repositoryService
      );
    }
    res.send(getSessionJSON(session));
  };

  private verifyFromEtherscan = async (
    origReq: Request,
    res: Response
  ): Promise<void> => {
    const req = origReq as LegacyVerifyRequest;
    validateRequest(req);

    const chain = req.body.chain as string;
    const address = req.body.address;

    const { compilerVersion, solcJsonInput, contractName } =
      await processRequestFromEtherscan(chain, address);

    const metadata = await getMetadataFromCompiler(
      compilerVersion,
      solcJsonInput,
      contractName
    );

    const mappedSources = getMappedSourcesFromJsonInput(solcJsonInput);
    const checkedContract = new CheckedContract(metadata, mappedSources);

    const match = await this.verificationService.verifyDeployed(
      checkedContract,
      chain,
      address
    );

    await this.repositoryService.storeMatch(checkedContract, match);

    res.send({ result: [match] });
  };

  private sessionVerifyFromEtherscan = async (
    origReq: Request,
    res: Response
  ): Promise<void> => {
    const req = origReq as LegacyVerifyRequest;
    validateRequest(req);

    const chain = req.body.chainId as string;
    const address = req.body.address;

    const { compilerVersion, solcJsonInput, contractName } =
      await processRequestFromEtherscan(chain, address);

    const metadata = await getMetadataFromCompiler(
      compilerVersion,
      solcJsonInput,
      contractName
    );

    const pathContents: PathContent[] = Object.keys(solcJsonInput.sources).map(
      (path) => {
        return {
          path: path,
          content: stringToBase64(solcJsonInput.sources[path].content),
        };
      }
    );
    pathContents.push({
      path: "metadata.json",
      content: stringToBase64(JSON.stringify(metadata)),
    });
    const session = req.session;
    const newFilesCount = saveFiles(pathContents, session);
    if (newFilesCount === 0) {
      throw new BadRequestError("The contract didn't add any new file");
    }

    await checkContractsInSession(session);
    if (!session.contractWrappers) {
      throw new BadRequestError(
        "Unknown error during the Etherscan verification process"
      );
      return;
    }

    const verifiable: ContractWrapperMap = {};
    for (const id of Object.keys(session.contractWrappers)) {
      const contractWrapper = session.contractWrappers[id];
      if (contractWrapper) {
        if (!contractWrapper.address) {
          contractWrapper.address = address;
          contractWrapper.chainId = chain;
        }
        if (isVerifiable(contractWrapper)) {
          verifiable[id] = contractWrapper;
        }
      }
    }

    await verifyContractsInSession(
      verifiable,
      session,
      this.verificationService,
      this.repositoryService
    );
    res.send(getSessionJSON(session));
  };

  private authenticatedRequest(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    const sourcifyClientTokensRaw = process.env.CREATE2_CLIENT_TOKENS;
    if (sourcifyClientTokensRaw?.length) {
      const sourcifyClientTokens = sourcifyClientTokensRaw.split(",");
      const clientToken = req.body.clientToken;
      if (!clientToken) {
        throw new BadRequestError("This API is protected by a client token");
      }
      if (!sourcifyClientTokens.includes(clientToken)) {
        throw new BadRequestError("The client token you provided is not valid");
      }
    }
    next();
  }

  private verifyCreate2 = async (
    req: Create2VerifyRequest,
    res: Response
  ): Promise<void> => {
    validateRequest(req);

    const {
      deployerAddress,
      salt,
      abiEncodedConstructorArguments,
      files,
      create2Address,
    } = req.body;

    const inputFiles = extractFilesFromJSON(files);
    if (!inputFiles) {
      throw new BadRequestError("No files found");
    }

    let checkedContracts: CheckedContract[];
    try {
      checkedContracts = await checkFiles(inputFiles);
    } catch (error) {
      if (error instanceof Error) throw new BadRequestError(error.message);
      throw error;
    }

    const errors = checkedContracts
      .filter((contract) => !CheckedContract.isValid(contract, true))
      .map(stringifyInvalidAndMissing);
    if (errors.length) {
      throw new BadRequestError(
        "Invalid or missing sources in:\n" + errors.join("\n")
      );
    }

    const contract: CheckedContract = checkedContracts[0];

    const match = await verifyCreate2(
      contract,
      deployerAddress,
      salt,
      create2Address,
      abiEncodedConstructorArguments
    );

    if (match.status) {
      await this.repositoryService.storeMatch(contract, match);
    }

    res.send({ result: [match] });
  };

  private sessionVerifyCreate2 = async (
    req: SessionCreate2VerifyRequest,
    res: Response
  ): Promise<void> => {
    const session = req.session;
    if (!session.contractWrappers || isEmpty(session.contractWrappers)) {
      throw new BadRequestError("There are currently no pending contracts.");
    }

    const {
      deployerAddress,
      salt,
      abiEncodedConstructorArguments,
      verificationId,
      create2Address,
    } = req.body;

    const contractWrapper = session.contractWrappers[verificationId];

    const contract = new CheckedContract(
      contractWrapper.contract.metadata,
      contractWrapper.contract.solidity,
      contractWrapper.contract.missing,
      contractWrapper.contract.invalid
    );

    const match = await verifyCreate2(
      contract,
      deployerAddress,
      salt,
      create2Address,
      abiEncodedConstructorArguments
    );

    contractWrapper.status = match.status || "error";
    contractWrapper.statusMessage = match.message;
    contractWrapper.storageTimestamp = match.storageTimestamp;
    contractWrapper.address = match.address;
    contractWrapper.chainId = "0";

    if (match.status) {
      await this.repositoryService.storeMatch(contract, match);
    }

    res.send(getSessionJSON(session));
  };

  private sessionPrecompileContract = async (
    req: Request,
    res: Response
  ): Promise<void> => {
    const session = req.session;
    if (!session.contractWrappers || isEmpty(session.contractWrappers)) {
      throw new BadRequestError("There are currently no pending contracts.");
    }

    const verificationId = req.body.verificationId;
    const contractWrapper = session.contractWrappers[verificationId];

    const checkedContract = new CheckedContract(
      contractWrapper.contract.metadata,
      contractWrapper.contract.solidity,
      contractWrapper.contract.missing,
      contractWrapper.contract.invalid
    );

    const compilationResult = await checkedContract.recompile();

    contractWrapper.contract.creationBytecode =
      compilationResult.creationBytecode;

    res.send(getSessionJSON(session));
  };

  registerRoutes = (): Router => {
    // Session APIs with session cookies require non "*" CORS
    this.router
      .route(["/session-data", "/session/data"])
      .get(this.safeHandler(this.getSessionDataEndpoint));

    this.router
      .route(["/input-files", "/session/input-files"])
      .post(this.safeHandler(this.addInputFilesEndpoint));

    this.router
      .route(["/session/input-solc-json"])
      .post(
        body("compilerVersion").exists().bail(),
        this.safeHandler(this.addInputSolcJsonEndpoint)
      );

    this.router
      .route(["/session/input-contract"])
      .post(this.safeHandler(this.addInputContractEndpoint));

    this.router
      .route(["/restart-session", "/session/clear"])
      .post(this.safeHandler(this.restartSessionEndpoint));

    this.router
      .route([
        "/verify-validated",
        "/session/verify-validated",
        "/session/verify-checked",
      ])
      .post(
        body("contracts").isArray(),
        this.safeHandler(this.verifyContractsInSessionEndpoint)
      );

    this.router.route(["/verify/etherscan"]).post(
      body("address")
        .exists()
        .bail()
        .custom(
          (address, { req }) => (req.addresses = validateAddresses(address))
        ),
      body("chainId")
        .optional()
        .custom(
          (chainId, { req }) =>
            // Support both `body.chain` and `body.chainId`
            // `checkChainId` won't be checked here but in the next `req.body.chain` check below to avoid duplicate error messages
            (req.body.chain = chainId)
        ),
      body("chain")
        .exists()
        .bail()
        .custom((chain) => checkSupportedChainId(chain)),
      this.safeHandler(this.verifyFromEtherscan)
    );

    this.router.route(["/session/verify/etherscan"]).post(
      body("address")
        .exists()
        .bail()
        .custom(
          (address, { req }) =>
            (req.body.addresses = validateAddresses(address))
        ),
      body("chain")
        .optional()
        .custom(
          (chain, { req }) =>
            // Support both `body.chain` and `body.chainId`
            (req.body.chainId = chain)
        ),
      body("chainId")
        .exists()
        .bail()
        .custom((chainId) => checkSupportedChainId(chainId)),
      this.safeHandler(this.sessionVerifyFromEtherscan)
    );

    // TODO: Use schema validation for request validation https://express-validator.github.io/docs/schema-validation.html
    this.router.route(["/verify/create2"]).post(
      body("deployerAddress")
        .exists()
        .bail()
        .custom((deployerAddress, { req }) => {
          const addresses = validateAddresses(deployerAddress);
          req.deployerAddress = addresses.length > 0 ? addresses[0] : "";
          return true;
        }),
      body("salt").exists().bail(),
      body("abiEncodedConstructorArguments").optional(),
      body("files").exists().bail(),
      body("create2Address")
        .exists()
        .bail()
        .custom((create2Address, { req }) => {
          const addresses = validateAddresses(create2Address);
          req.create2Address = addresses.length > 0 ? addresses[0] : "";
          return true;
        }),
      this.authenticatedRequest,
      this.safeHandler(this.verifyCreate2)
    );

    this.router.route(["/session/verify/create2"]).post(
      body("deployerAddress")
        .exists()
        .custom((deployerAddress, { req }) => {
          const addresses = validateAddresses(deployerAddress);
          req.deployerAddress = addresses.length > 0 ? addresses[0] : "";
          return true;
        }),
      body("salt").exists(),
      body("abiEncodedConstructorArguments").optional(),
      body("files").exists(),
      body("create2Address")
        .exists()
        .custom((create2Address, { req }) => {
          const addresses = validateAddresses(create2Address);
          req.create2Address = addresses.length > 0 ? addresses[0] : "";
          return true;
        }),
      body("verificationId").exists(),
      this.authenticatedRequest,
      this.safeHandler(this.sessionVerifyCreate2)
    );

    this.router
      .route(["/session/verify/create2/compile"])
      .post(
        body("verificationId").exists(),
        this.safeHandler(this.sessionPrecompileContract)
      );

    return this.router;
  };
}
