/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { Disposable, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IAideAgentImplementation } from 'vs/workbench/contrib/aideAgent/common/aideAgent';
import { AideAgentModel } from 'vs/workbench/contrib/aideAgent/common/aideAgentModel';
import { IAgentResponseProgress, IAideAgentService } from 'vs/workbench/contrib/aideAgent/common/aideAgentService';

export class AideAgentService extends Disposable implements IAideAgentService {
	declare _serviceBrand: undefined;

	private agentProvider: IAideAgentImplementation | undefined;
	private _model: AideAgentModel | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
	}

	registerAgentProvider(resolver: IAideAgentImplementation): IDisposable {
		if (this.agentProvider) {
			throw new Error('Aide agent provider already registered');
		}

		this.agentProvider = resolver;
		return toDisposable(() => {
			this.agentProvider = undefined;
		});
	}

	startSession(): AideAgentModel | undefined {
		this._model = this.instantiationService.createInstance(AideAgentModel);
		return this._model;
	}

	trigger(message: string): void {
		const model = this._model;
		if (!model) {
			return;
		}

		const cts = new CancellationTokenSource();
		const token = cts.token;
		const triggerAgentInternal = async () => {
			const progressCallback = async (progress: IAgentResponseProgress) => {
				if (token.isCancellationRequested) {
					return;
				}
			};

			const listener = token.onCancellationRequested(() => {
				// cancel the request
			});

			try {
				// trigger the agent
			} catch (error) {
				console.log(error);
			} finally {
				listener.dispose();
			}
		};

		const rawResponsePromise = triggerAgentInternal();
		rawResponsePromise.finally(() => {
			// cleanup
		});
	}
}
